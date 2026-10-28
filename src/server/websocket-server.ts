import type { IncomingMessage, Server } from "node:http";
import type { Socket } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import type { ClientMessage } from "../types.js";
import type { AuthenticatedUser } from "./auth.js";
import type { Logger } from "./logger.js";

type AuthenticatedUpgradeRequest = IncomingMessage & { authenticatedUser?: AuthenticatedUser };

export type WebsocketEvent =
	| { type: "client_connected"; client: WebSocket; user: AuthenticatedUser; userId: string }
	| { type: "client_disconnected"; client: WebSocket; userId: string }
	| { type: "audio_frame"; userId: string; data: Buffer }
	| { type: "client_message"; userId: string; message: ClientMessage };

// A connection replaced by a newer one from the same account closes with this code; the browser shows
// "open on another device" instead of reconnecting (which would bump the new connection in turn).
export const replacedCloseCode = 4000;
const heartbeatIntervalMs = 10_000;

export interface WebsocketServer {
	send: (userId: string, message: object) => void;
	broadcast: (message: object) => void;
}

export function attachWebSockets(deps: {
	server: Server;
	logger: Logger;
	authenticate: (req: IncomingMessage) => Promise<AuthenticatedUser | undefined>;
	onClientSocket: (socket: Socket, userId: string) => void;
	onEvent: (event: WebsocketEvent) => void | Promise<void>;
}): WebsocketServer {
	const clients = new Map<string, WebSocket>();
	const logger = deps.logger.tag("server");
	const emit = (event: WebsocketEvent) => {
		void Promise.resolve(deps.onEvent(event)).catch((error) => {
			console.error(`[websocket] event handler failed: ${error instanceof Error ? error.message : String(error)}`);
		});
	};
	const robotWss = new WebSocketServer({ noServer: true });
	// Dead sockets (phone asleep, network switched) never answer pings; terminate them so the close
	// handlers run and the account can reconnect cleanly.
	const alive = new Set<WebSocket>();
	setInterval(() => {
		for (const ws of clients.values()) {
			if (!alive.has(ws)) {
				ws.terminate();
				continue;
			}
			alive.delete(ws);
			ws.ping();
		}
	}, heartbeatIntervalMs).unref();
	const reloadWss = new WebSocketServer({ noServer: true });

	deps.server.on("upgrade", (req, socket, head) => {
		void (async () => {
			const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
			if (url.pathname === "/__reload") {
				reloadWss.handleUpgrade(req, socket, head, (ws) => reloadWss.emit("connection", ws, req));
				return;
			}
			const user = await deps.authenticate(req);
			if (!user) {
				socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
				socket.destroy();
				return;
			}
			(req as AuthenticatedUpgradeRequest).authenticatedUser = user;
			robotWss.handleUpgrade(req, socket, head, (ws) => robotWss.emit("connection", ws, req));
		})().catch((error) => {
			logger.tag("error").log(error instanceof Error ? error.message : String(error));
			socket.destroy();
		});
	});

	robotWss.on("connection", (ws, req) => {
		const user = (req as AuthenticatedUpgradeRequest).authenticatedUser;
		if (!user) {
			ws.close(1008, "Authentication required");
			return;
		}
		const userId = user.name;
		// Newest connection wins: a phone that switched networks may still look connected for minutes.
		const existingClient = clients.get(userId);
		clients.set(userId, ws);
		if (existingClient && existingClient.readyState !== WebSocket.CLOSED) {
			logger.log(`new ws client for ${userId} replaces the previous one`);
			existingClient.close(replacedCloseCode, "pibot was opened on another device");
		}
		alive.add(ws);
		ws.on("pong", () => alive.add(ws));
		deps.onClientSocket(req.socket, userId);
		emit({ type: "client_connected", client: ws, user, userId });
		ws.on("message", (data, isBinary) => {
			if (clients.get(userId) !== ws) return;
			try {
				if (isBinary) {
					emit({
						type: "audio_frame",
						userId,
						data: Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer),
					});
					return;
				}
				emit({ type: "client_message", userId, message: JSON.parse(String(data)) as ClientMessage });
			} catch (error) {
				logger.tag("error").log(error instanceof Error ? error.message : String(error));
			}
		});
		ws.on("close", () => {
			alive.delete(ws);
			// A replaced connection closing must not tear down the state of the one that replaced it.
			if (clients.get(userId) !== ws) return;
			clients.delete(userId);
			emit({ type: "client_disconnected", client: ws, userId });
		});
	});

	reloadWss.on("connection", () => {
		// The client reloads when this socket reconnects after the dev supervisor restarts the server.
	});

	return {
		send: (userId: string, message: object) => {
			const client = clients.get(userId);
			if (client?.readyState === WebSocket.OPEN) client.send(JSON.stringify(message));
		},
		broadcast: (message: object) => {
			const text = JSON.stringify(message);
			for (const client of clients.values()) {
				if (client.readyState === WebSocket.OPEN) client.send(text);
			}
		},
	};
}
