import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import type { ClientMessage, RobotRpcMap, RobotRpcType, RobotWireCancel, RobotWireResponse } from "../types.js";

type RobotRpcResponse = RobotRpcMap[RobotRpcType]["response"];

const ttsFrameStart = 1;
const ttsFrameAudio = 2;
const ttsFrameDone = 3;
const ttsFrameError = 4;
const ttsFrameOpus = 5;

interface PendingRobotRequest {
	requestType: RobotRpcType;
	resolve: (value: RobotRpcResponse) => void;
	reject: (error: Error) => void;
	timeout: NodeJS.Timeout | undefined;
	cleanup: () => void;
}

export class RobotClient {
	private current: WebSocket | undefined;
	private readonly pending = new Map<string, PendingRobotRequest>();
	private readonly heartbeat: NodeJS.Timeout;

	constructor() {
		this.heartbeat = setInterval(() => this.checkConnection(), 5000);
	}

	setWebSocket(client: WebSocket): void {
		if (this.current?.readyState === WebSocket.OPEN) return;
		this.current = client;
		client.once("close", () => this.clearWebSocket(client));
		client.once("error", () => this.clearWebSocket(client));
	}

	private clearWebSocket(client: WebSocket): void {
		if (this.current !== client) return;
		this.current = undefined;
		this.rejectAll("Robot client disconnected");
	}

	handleMessage(msg: ClientMessage): boolean {
		if (msg.type !== "robot_response") return false;
		this.resolveResponse(msg);
		return true;
	}

	async execute<const T extends RobotRpcType>(request: {
		type: T;
		payload: RobotRpcMap[T]["request"];
		timeoutMs: number | null;
		signal?: AbortSignal;
	}): Promise<RobotRpcMap[T]["response"]> {
		if (request.signal?.aborted) throw new Error(`Robot request aborted: ${request.type}`);
		const client = this.current;
		if (!client || client.readyState !== WebSocket.OPEN) throw new Error("Robot client not connected");
		const id = randomUUID();
		return await new Promise<RobotRpcMap[T]["response"]>((resolve, reject) => {
			const timeout =
				request.timeoutMs === null
					? undefined
					: setTimeout(() => {
							const reason = `Robot request timed out: ${request.type}`;
							this.cancelRemote(id, reason);
							this.rejectPending(id, new Error(reason));
						}, request.timeoutMs);
			const onAbort = () => {
				const reason = `Robot request aborted: ${request.type}`;
				this.cancelRemote(id, reason);
				this.rejectPending(id, new Error(reason));
			};
			this.pending.set(id, {
				requestType: request.type,
				resolve: (value) => resolve(value as RobotRpcMap[T]["response"]),
				reject,
				timeout,
				cleanup: () => request.signal?.removeEventListener("abort", onAbort),
			});
			if (request.signal) {
				request.signal.addEventListener("abort", onAbort, { once: true });
				if (request.signal.aborted) {
					onAbort();
					return;
				}
			}
			try {
				client.send(
					JSON.stringify({ type: "robot_request", id, request: { type: request.type, payload: request.payload } }),
				);
			} catch (error) {
				this.rejectPending(id, error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	rejectAll(reason: string): void {
		for (const id of this.pending.keys()) this.rejectPending(id, new Error(reason));
	}

	sendTtsStart(sampleRate: number): boolean {
		const payload = Buffer.allocUnsafe(4);
		payload.writeUInt32LE(sampleRate, 0);
		return this.sendBinaryFrame(ttsFrameStart, payload);
	}

	sendTtsAudio(pcm: Uint8Array): boolean {
		return this.sendBinaryFrame(ttsFrameAudio, pcm);
	}

	sendTtsOpus(packet: Uint8Array): boolean {
		return this.sendBinaryFrame(ttsFrameOpus, packet);
	}

	sendTtsDone(): boolean {
		return this.sendBinaryFrame(ttsFrameDone);
	}

	sendTtsError(message: string): boolean {
		return this.sendBinaryFrame(ttsFrameError, Buffer.from(message, "utf8"));
	}

	stop(): void {
		clearInterval(this.heartbeat);
		this.rejectAll("Robot client stopped");
	}

	private sendBinaryFrame(kind: number, payload?: Uint8Array): boolean {
		const client = this.current;
		if (!client || client.readyState !== WebSocket.OPEN) return false;
		const payloadLength = payload?.byteLength ?? 0;
		const frame = Buffer.allocUnsafe(1 + payloadLength);
		frame.writeUInt8(kind, 0);
		if (payload) Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength).copy(frame, 1);
		try {
			client.send(frame);
			return true;
		} catch {
			this.clearWebSocket(client);
			return false;
		}
	}

	private cancelRemote(requestId: string, reason: string): void {
		const client = this.current;
		if (!client || client.readyState !== WebSocket.OPEN) return;
		const message: RobotWireCancel = { type: "robot_cancel", id: requestId, reason };
		try {
			client.send(JSON.stringify(message));
		} catch {
			// best-effort cancellation
		}
	}

	private resolveResponse(response: RobotWireResponse): void {
		const pending = this.pending.get(response.id);
		if (!pending) return;
		if (pending.requestType !== response.requestType) {
			this.rejectPending(
				response.id,
				new Error(`Robot response type mismatch: expected ${pending.requestType}, got ${response.requestType}`),
			);
			return;
		}
		if (pending.timeout) clearTimeout(pending.timeout);
		pending.cleanup();
		this.pending.delete(response.id);
		if (response.error) {
			pending.reject(new Error(response.error));
			return;
		}
		if (response.payload === undefined) {
			pending.reject(new Error(`Robot response missing payload: ${response.requestType}`));
			return;
		}
		pending.resolve(response.payload);
	}

	private rejectPending(id: string, error: Error): void {
		const pending = this.pending.get(id);
		if (!pending) return;
		if (pending.timeout) clearTimeout(pending.timeout);
		pending.cleanup();
		this.pending.delete(id);
		pending.reject(error);
	}

	// Liveness pings live in websocket-server.ts (they terminate dead sockets); here only drop a socket
	// that has already closed so pending requests fail fast.
	private checkConnection(): void {
		const client = this.current;
		if (client && client.readyState !== WebSocket.OPEN) this.clearWebSocket(client);
	}
}
