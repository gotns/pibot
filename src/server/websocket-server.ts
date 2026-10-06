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
		const existingClient = clients.get(userId);
		if (existingClient?.readyState === WebSocket.OPEN) {
			logger.log(`rejected extra ws client for ${userId}`);
			ws.close(1008, "This user is already connected");
			return;
		}
		clients.set(userId, ws);
		deps.onClientSocket(req.socket, userId);
		emit({ type: "client_connected", client: ws, user, userId });
		ws.on("message", (data, isBinary) => {
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
			if (clients.get(userId) === ws) clients.delete(userId);
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
