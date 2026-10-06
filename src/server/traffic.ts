import { subscribe } from "node:diagnostics_channel";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { isIPv4, type Socket } from "node:net";
import { dirname } from "node:path";
import type { Logger } from "./logger.js";

// Byte counters for every TCP connection pibot itself makes or accepts, persisted across restarts.
// Counts socket payload: HTTP/WebSocket bytes as sent (compressed), after TLS decryption. TCP/IP,
// TLS and WireGuard overhead are not visible to Node and are not included.

interface Counter {
	down: number;
	up: number;
}

type Category = "clients" | "internet" | "local";

interface TrafficTotals {
	since: string;
	clients: Counter;
	internet: Counter;
	local: Counter;
	internetHosts: Record<string, Counter>;
	users: Record<string, Counter>;
}

interface TrackedSocket {
	category: Category;
	host?: string;
	user?: string;
	connectedAt: number;
	read: number;
	written: number;
	sessionDown: number;
	sessionUp: number;
}

export interface TrafficMeter {
	trackServer: (server: Server) => void;
	attributeToUser: (socket: Socket, user: string) => void;
	stop: () => Promise<void>;
}

const flushIntervalMs = 60_000;
const summaryIntervalMs = 30 * 60_000;

function emptyTotals(): TrafficTotals {
	return {
		since: new Date().toISOString(),
		clients: { down: 0, up: 0 },
		internet: { down: 0, up: 0 },
		local: { down: 0, up: 0 },
		internetHosts: {},
		users: {},
	};
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const units = ["KB", "MB", "GB", "TB"];
	let value = bytes / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	return `${value.toFixed(value < 10 ? 2 : 1)} ${units[unit]}`;
}

function formatCounter(counter: Counter): string {
	return `down ${formatBytes(counter.down)} / up ${formatBytes(counter.up)}`;
}

// Loopback, tailnet (CGNAT 100.64/10, Tailscale ULA), RFC 1918, link-local and IPv6 ULA never leave the
// box or the tailnet as plain internet traffic; everything else is internet.
export function isLocalAddress(address: string): boolean {
	const ip = address.startsWith("::ffff:") ? address.slice(7) : address;
	if (isIPv4(ip)) {
		const [a = 0, b = 0] = ip.split(".").map(Number);
		return (
			a === 127 ||
			a === 10 ||
			(a === 100 && b >= 64 && b <= 127) ||
			(a === 172 && b >= 16 && b <= 31) ||
			(a === 192 && b === 168) ||
			(a === 169 && b === 254)
		);
	}
	const lower = ip.toLowerCase();
	return lower === "::1" || lower.startsWith("fd") || lower.startsWith("fc") || lower.startsWith("fe80");
}

function addTo(counter: Counter, down: number, up: number): void {
	counter.down += down;
	counter.up += up;
}

export async function createTrafficMeter(deps: { file: string; logger: Logger }): Promise<TrafficMeter> {
	const logger = deps.logger.tag("traffic");
	let totals = emptyTotals();
	try {
		totals = { ...totals, ...(JSON.parse(await readFile(deps.file, "utf8")) as Partial<TrafficTotals>) };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			logger.log(`could not read ${deps.file}, starting new totals: ${(error as Error).message}`);
		}
	}
	const sockets = new Map<Socket, TrackedSocket>();
	let dirty = false;
	let lastSummaryTotals = "";

	function account(socket: Socket, tracked: TrackedSocket): void {
		const down = socket.bytesRead - tracked.read;
		const up = (socket.bytesWritten ?? 0) - tracked.written;
		if (down <= 0 && up <= 0) return;
		tracked.read += down;
		tracked.written += up;
		tracked.sessionDown += down;
		tracked.sessionUp += up;
		addTo(totals[tracked.category], down, up);
		if (tracked.host) {
			totals.internetHosts[tracked.host] ??= { down: 0, up: 0 };
			addTo(totals.internetHosts[tracked.host], down, up);
		}
		if (tracked.user) {
			totals.users[tracked.user] ??= { down: 0, up: 0 };
			addTo(totals.users[tracked.user], down, up);
		}
		dirty = true;
	}

	function track(
		socket: Socket,
		tracked: Omit<TrackedSocket, "read" | "written" | "sessionDown" | "sessionUp">,
	): void {
		if (sockets.has(socket)) return;
		const entry: TrackedSocket = { ...tracked, read: 0, written: 0, sessionDown: 0, sessionUp: 0 };
		sockets.set(socket, entry);
		socket.once("close", () => {
			account(socket, entry);
			sockets.delete(socket);
			if (entry.user) {
				const minutes = ((Date.now() - entry.connectedAt) / 60_000).toFixed(1);
				logger.log(
					`[${entry.user}] connection closed after ${minutes} min: down ${formatBytes(entry.sessionDown)} (mic audio) / up ${formatBytes(entry.sessionUp)} (speech audio)`,
				);
			}
		});
	}

	function summary(): string {
		const hosts = Object.entries(totals.internetHosts)
			.sort(([, a], [, b]) => b.down + b.up - (a.down + a.up))
			.slice(0, 5)
			.map(([host, counter]) => `${host} ${formatBytes(counter.down + counter.up)}`)
			.join(", ");
		const users = Object.entries(totals.users)
			.map(([user, counter]) => `${user} ${formatCounter(counter)}`)
			.join(", ");
		return `totals since ${new Date(totals.since).toLocaleString("sv-SE").slice(0, 16)}: internet ${formatCounter(totals.internet)}${hosts ? ` [${hosts}]` : ""}; tailnet clients ${formatCounter(totals.clients)}${users ? ` [${users}]` : ""}; local LLM ${formatCounter(totals.local)}`;
	}

	async function flush(): Promise<void> {
		for (const [socket, tracked] of sockets) account(socket, tracked);
		if (!dirty) return;
		dirty = false;
		await mkdir(dirname(deps.file), { recursive: true });
		const tmp = `${deps.file}.tmp`;
		await writeFile(tmp, `${JSON.stringify(totals, null, "\t")}\n`);
		await rename(tmp, deps.file);
	}

	// Node's fetch (undici) reports each new outbound connection here, for http and https alike.
	subscribe("undici:client:connected", (message) => {
		const { socket, connectParams } = message as { socket: Socket; connectParams: { hostname: string } };
		const local = isLocalAddress(socket.remoteAddress ?? "");
		track(socket, {
			category: local ? "local" : "internet",
			host: local ? undefined : connectParams.hostname,
			connectedAt: Date.now(),
		});
	});

	const flushTimer = setInterval(() => {
		void flush().catch((error: unknown) => logger.log(`could not save totals: ${(error as Error).message}`));
	}, flushIntervalMs);
	const summaryTimer = setInterval(() => {
		const line = summary();
		if (line !== lastSummaryTotals) logger.log(line);
		lastSummaryTotals = line;
	}, summaryIntervalMs);
	flushTimer.unref();
	summaryTimer.unref();
	lastSummaryTotals = summary();
	logger.log(lastSummaryTotals);

	return {
		trackServer: (server) => {
			server.on("connection", (socket: Socket) => track(socket, { category: "clients", connectedAt: Date.now() }));
		},
		attributeToUser: (socket, user) => {
			const tracked = sockets.get(socket);
			if (!tracked) return;
			// Bytes so far (the HTTP upgrade) stay unattributed; from here on they count for the user too.
			account(socket, tracked);
			tracked.user = user;
			tracked.sessionDown = 0;
			tracked.sessionUp = 0;
		},
		stop: async () => {
			clearInterval(flushTimer);
			clearInterval(summaryTimer);
			await flush();
			logger.log(summary());
		},
	};
}
