import { lookup, resolve4, reverse } from "node:dns/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import type { RadioStation } from "../types.js";
import type { Logger } from "./logger.js";
import { isLocalAddress } from "./traffic.js";

// Internet radio from the community Radio Browser directory (no key, no account). The browser plays
// https streams directly; plain-http streams would be blocked as mixed content on the https page, so
// the server relays those at /api/radio/stream/<uuid>.

const userAgent = "pibot/0.1 (+https://github.com/badlogic/pibot)";
const fallbackServers = ["de1.api.radio-browser.info"];
// Formats every browser plays from a plain <audio> element. HLS and OGG are skipped (Safari, Chrome).
const playableCodecs = new Set(["MP3", "AAC", "AAC+"]);
const maxRedirects = 3;

interface RadioBrowserStation {
	stationuuid: string;
	name: string;
	url_resolved?: string;
	country?: string;
	tags?: string;
	favicon?: string;
	codec?: string;
	bitrate?: number;
	hls?: number;
	lastcheckok?: number;
}

export interface RadioService {
	search: (options: {
		query: string;
		searchBy: "tag" | "name";
		countryCode?: string;
		limit: number;
	}) => Promise<RadioStation[]>;
	prepare: (uuid: string) => Promise<{ station: RadioStation; url: string }>;
	relay: (uuid: string, req: IncomingMessage, res: ServerResponse) => Promise<void>;
}

function toStation(entry: RadioBrowserStation): RadioStation {
	return {
		uuid: entry.stationuuid,
		name: entry.name.trim(),
		country: entry.country || undefined,
		tags: entry.tags || undefined,
		favicon: entry.favicon || undefined,
		codec: entry.codec || undefined,
		bitrate: entry.bitrate || undefined,
	};
}

export function createRadioService(deps: { logger: Logger }): RadioService {
	const logger = deps.logger.tag("radio");
	const stations = new Map<string, RadioBrowserStation>();
	let servers: string[] | undefined;

	// Radio Browser asks clients to find mirrors via DNS and spread load across them.
	async function serverList(): Promise<string[]> {
		if (servers) return servers;
		try {
			const names = await Promise.all(
				(await resolve4("all.api.radio-browser.info")).map(async (ip) => (await reverse(ip))[0]),
			);
			const found = names.filter((name): name is string => Boolean(name?.endsWith(".api.radio-browser.info")));
			servers = found.length > 0 ? found.sort(() => Math.random() - 0.5) : fallbackServers;
		} catch {
			servers = fallbackServers;
		}
		return servers;
	}

	async function directory<T>(path: string): Promise<T> {
		let lastError: unknown;
		for (const server of await serverList()) {
			try {
				const response = await fetch(`https://${server}${path}`, {
					headers: { "User-Agent": userAgent },
					signal: AbortSignal.timeout(8000),
				});
				if (!response.ok) throw new Error(`HTTP ${response.status}`);
				return (await response.json()) as T;
			} catch (error) {
				lastError = error;
			}
		}
		throw new Error(
			`Radio directory unreachable: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
		);
	}

	async function station(uuid: string): Promise<RadioBrowserStation> {
		const cached = stations.get(uuid);
		if (cached) return cached;
		const [found] = await directory<RadioBrowserStation[]>(`/json/stations/byuuid/${encodeURIComponent(uuid)}`);
		if (!found) throw new Error(`Unknown radio station: ${uuid}. Use a stationuuid from radio_search.`);
		stations.set(uuid, found);
		return found;
	}

	// Station URLs come from a community-edited directory: refuse anything that resolves to this box,
	// the tailnet or the LAN, so the relay cannot be pointed at the LLM server or other private services.
	async function assertPublic(url: URL): Promise<void> {
		if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Unsupported stream URL");
		const addresses = await lookup(url.hostname, { all: true });
		if (addresses.length === 0 || addresses.some((entry) => isLocalAddress(entry.address))) {
			throw new Error(`Refusing to relay a stream on a private address: ${url.hostname}`);
		}
	}

	return {
		search: async ({ query, searchBy, countryCode, limit }) => {
			const params = new URLSearchParams({
				[searchBy]: query,
				hidebroken: "true",
				order: "clickcount",
				reverse: "true",
				limit: "40",
			});
			if (countryCode) params.set("countrycode", countryCode.toUpperCase());
			const found = await directory<RadioBrowserStation[]>(`/json/stations/search?${params.toString()}`);
			const playable = found
				.filter(
					(entry) => entry.url_resolved && !entry.hls && playableCodecs.has((entry.codec ?? "").toUpperCase()),
				)
				.slice(0, Math.max(1, Math.min(10, Math.floor(limit))));
			for (const entry of playable) stations.set(entry.stationuuid, entry);
			return playable.map(toStation);
		},
		prepare: async (uuid) => {
			const entry = await station(uuid);
			const url = entry.url_resolved ?? "";
			if (!/^https?:\/\//.test(url)) throw new Error(`Station ${entry.name} has no playable stream URL`);
			// Counts a "click" for the station's popularity ranking, as the directory asks clients to do.
			void directory(`/json/url/${encodeURIComponent(uuid)}`).catch(() => undefined);
			return {
				station: toStation(entry),
				url: url.startsWith("https://") ? url : `/api/radio/stream/${encodeURIComponent(uuid)}`,
			};
		},
		relay: async (uuid, req, res) => {
			const entry = await station(uuid);
			const controller = new AbortController();
			req.once("close", () => controller.abort());
			let url = new URL(entry.url_resolved ?? "");
			let response: Response | undefined;
			for (let hop = 0; hop <= maxRedirects; hop++) {
				await assertPublic(url);
				response = await fetch(url, {
					headers: { "User-Agent": userAgent },
					redirect: "manual",
					signal: controller.signal,
				});
				const location = response.headers.get("location");
				if (response.status < 300 || response.status >= 400 || !location) break;
				url = new URL(location, url);
			}
			if (!response?.ok || !response.body) {
				res.writeHead(502, { "content-type": "text/plain" }).end(`stream unavailable: HTTP ${response?.status}`);
				return;
			}
			logger.log(`relaying ${entry.name} from ${url.host}`);
			res.writeHead(200, {
				"content-type": response.headers.get("content-type") ?? "audio/mpeg",
				"cache-control": "no-store",
			});
			// The station dropping or the listener leaving ends the relay; neither may crash the server.
			Readable.fromWeb(response.body as WebReadableStream)
				.on("error", () => res.destroy())
				.pipe(res);
		},
	};
}
