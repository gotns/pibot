import type {
	ClientMessage,
	LogEntry,
	RobotRpcMap,
	RobotRpcType,
	RobotState,
	RobotWireCancel,
	RobotWireRequest,
	ServerMessage,
	SpotifyNowPlaying,
} from "../types.js";
import type { ClientLogger } from "./logger.js";
import type { RobotToolHandlers } from "./tools/index.js";

interface ActiveRobotRequest {
	type: RobotRpcType;
	controller: AbortController;
}

export interface RobotServerTtsHandlers {
	startPcmStream: (sampleRate: number) => void;
	pushPcmAudio: (pcm: Uint8Array) => void;
	finishPcmStream: () => Promise<void>;
	failPcmStream: (message: string) => void;
}

const ttsFrameStart = 1;
const ttsFrameAudio = 2;
const ttsFrameDone = 3;
const ttsFrameError = 4;

export interface RobotServerEvents {
	onState: (state: RobotState) => void;
	onLog: (entry: LogEntry) => void;
	onSpotifyPlayback: (playback: SpotifyNowPlaying | undefined) => void;
	onRejected: (reason: string) => void;
}

export class RobotServer {
	private readonly ws: WebSocket;
	private readonly logger: ClientLogger;
	private readonly tools: RobotToolHandlers;
	private readonly tts: RobotServerTtsHandlers;
	private readonly events: RobotServerEvents;
	private readonly activeRobotRequests = new Map<string, ActiveRobotRequest>();

	constructor(deps: {
		url: string;
		logger: ClientLogger;
		tools: RobotToolHandlers;
		tts: RobotServerTtsHandlers;
		events: RobotServerEvents;
	}) {
		this.logger = deps.logger;
		this.tools = deps.tools;
		this.tts = deps.tts;
		this.events = deps.events;
		this.ws = new WebSocket(deps.url);
		this.ws.binaryType = "arraybuffer";
		this.ws.onopen = () => this.logger.tag("network").log("connected to robot server");
		this.ws.onclose = (event) => this.handleClose(event);
		this.ws.onerror = () => this.logger.tag("network").log("robot server connection error");
		this.ws.onmessage = (event) => this.handleMessage(event);
	}

	send(message: ClientMessage): void {
		if (this.ws.readyState !== WebSocket.OPEN) return;
		this.ws.send(JSON.stringify(message));
	}

	sendBinary(data: BufferSource): void {
		if (this.ws.readyState !== WebSocket.OPEN) return;
		this.ws.send(data);
	}

	isOpen(): boolean {
		return this.ws.readyState === WebSocket.OPEN;
	}

	private handleClose(event: CloseEvent): void {
		if (event.code === 1008) {
			this.events.onRejected(event.reason || "another client is already connected");
			return;
		}
		this.logger
			.tag("network")
			.log(`disconnected from robot server code=${event.code} reason=${event.reason || "none"}`);
	}

	private handleMessage(event: MessageEvent): void {
		if (event.data instanceof ArrayBuffer) {
			this.handleBinaryMessage(new Uint8Array(event.data));
			return;
		}
		if (event.data instanceof Blob) {
			void event.data.arrayBuffer().then((buffer) => this.handleBinaryMessage(new Uint8Array(buffer)));
			return;
		}
		const message = JSON.parse(String(event.data)) as ServerMessage;

		if (message.type === "robot_request") {
			void this.handleRequest(message);
			return;
		}
		if (message.type === "robot_cancel") {
			this.handleCancel(message);
			return;
		}
		if (message.type === "state") {
			this.events.onState(message.state);
			return;
		}
		if (message.type === "spotify_playback") {
			this.events.onSpotifyPlayback(message.playback);
			return;
		}
		if (message.type === "log") this.events.onLog(message.entry);
	}

	private handleBinaryMessage(bytes: Uint8Array): void {
		const kind = bytes[0];
		const payload = bytes.subarray(1);
		if (kind === ttsFrameStart) {
			if (payload.byteLength < 4) {
				this.send({ type: "tts_playback_error", message: "TTS start frame missing sample rate" });
				return;
			}
			const sampleRate = new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(0, true);
			this.tts.startPcmStream(sampleRate);
			return;
		}
		if (kind === ttsFrameAudio) {
			this.tts.pushPcmAudio(payload);
			return;
		}
		if (kind === ttsFrameDone) {
			void this.tts
				.finishPcmStream()
				.then(() => this.send({ type: "tts_playback_done" }))
				.catch((error: unknown) =>
					this.send({
						type: "tts_playback_error",
						message: error instanceof Error ? error.message : String(error),
					}),
				);
			return;
		}
		if (kind === ttsFrameError) {
			const message = new TextDecoder().decode(payload);
			this.tts.failPcmStream(message);
			this.send({ type: "tts_playback_error", message });
		}
	}

	private async handleRequest(message: RobotWireRequest): Promise<void> {
		const controller = new AbortController();
		this.activeRobotRequests.set(message.id, { type: message.request.type, controller });
		try {
			const payload = await this.executeRequest(message, controller.signal);
			this.sendResponse(message.id, message.request.type, payload);
		} catch (error) {
			this.sendError(message.id, message.request.type, error instanceof Error ? error.message : String(error));
		} finally {
			this.activeRobotRequests.delete(message.id);
		}
	}

	private async executeRequest(
		message: RobotWireRequest,
		signal: AbortSignal,
	): Promise<RobotRpcMap[RobotRpcType]["response"]> {
		if (message.request.type === "take_photo") return await this.tools.take_photo(message.request.payload, signal);
		if (message.request.type === "motor") return await this.tools.motor(message.request.payload, signal);
		if (message.request.type === "radio") return await this.tools.radio(message.request.payload, signal);
		if (message.request.type === "speak") return await this.tools.speak(message.request.payload, signal);
		return await this.tools.cancel_speech(message.request.payload, signal);
	}

	private handleCancel(message: RobotWireCancel): void {
		const active = this.activeRobotRequests.get(message.id);
		if (!active) {
			this.logger.tag("robot").log(`cancel ignored for inactive robot request ${message.id}`);
			return;
		}
		this.logger.tag("robot").log(`cancel ${active.type} request ${message.id}: ${message.reason}`);
		active.controller.abort(message.reason);
	}

	private sendResponse<T extends RobotRpcType>(id: string, requestType: T, payload: RobotRpcMap[T]["response"]): void {
		this.send({ type: "robot_response", id, requestType, payload } as ClientMessage);
	}

	private sendError(id: string, requestType: RobotRpcType, error: string): void {
		if (requestType === "take_photo") {
			this.send({ type: "robot_response", id, requestType, error });
			return;
		}
		if (requestType === "motor") {
			this.send({ type: "robot_response", id, requestType, error });
			return;
		}
		if (requestType === "radio") {
			this.send({ type: "robot_response", id, requestType, error });
			return;
		}
		if (requestType === "speak") {
			this.send({ type: "robot_response", id, requestType, error });
			return;
		}
		this.send({ type: "robot_response", id, requestType, error });
	}
}
