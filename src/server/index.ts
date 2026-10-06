import { dirname, join } from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { RobotState, ServerMessage } from "../types.js";
import { type AuthenticatedUser, UserAuthService } from "./auth.js";
import { serverConfig } from "./config.js";
import { createRobotHarness, type RobotHarness, type RobotHarnessEvent } from "./harness.js";
import { createHttpServer } from "./http-server.js";
import { createLlamaService, localLlmConfigs } from "./llama.js";
import { createLogger, formatEntry } from "./logger.js";
import { createFileMemoryStore } from "./memory-store.js";
import { createRadioService } from "./radio.js";
import { RobotClient } from "./robot-client.js";
import { createSentenceChunker, type SentenceChunker } from "./sentence-chunker.js";
import { onShutdown } from "./shutdown.js";
import { createSpotifyService } from "./spotify.js";
import { createSttService, type SttEvent } from "./stt.js";
import type { MemoryStore } from "./tools/memory.js";
import { createTrafficMeter } from "./traffic.js";
import { createTtsService } from "./tts.js";
import { attachWebSockets as createWebSocketServer, type WebsocketEvent } from "./websocket-server.js";

interface UserRuntime {
	user: AuthenticatedUser;
	userId: string;
	connected: boolean;
	robot: RobotClient;
	harness: RobotHarness;
	state: RobotState;
	speechActive: boolean;
	lastSpeechEndedAt: number;
	stoppedUtteranceIndex: number | undefined;
	activeChunker: SentenceChunker | undefined;
	activeAssistantText: string;
	ttsStartedForTurn: boolean;
	speechPlaybackFinished: Promise<void> | undefined;
	resolveSpeechPlaybackFinished: (() => void) | undefined;
	bargeInActive: boolean;
	activeToolState: { name: string; args: unknown } | undefined;
	memoryStore: MemoryStore;
	radioPlaying: boolean;
}

let sendToUser: (userId: string, message: ServerMessage) => void = () => undefined;
let sttReady = false;

const logger = createLogger((entry) => {
	console.log(formatEntry(entry, true));
	const userTag = entry.tags.find((tag) => tag.startsWith("user:"));
	const userId = userTag?.slice("user:".length) ?? /^\[([a-z0-9_-]{1,32})] /.exec(entry.message)?.[1];
	if (userId) sendToUser(userId, { type: "log", entry });
});
const serverLogger = logger.tag("server");
const agentLogger = logger.tag("agent");
const sttLogger = logger.tag("stt");
const ttsLogger = logger.tag("tts");
const executionEnv = new NodeExecutionEnv({ cwd: process.cwd() });
const auth = new UserAuthService({
	usersFile: serverConfig.usersFile,
	sessionsFile: serverConfig.sessionsFile,
	userMemoryDir: serverConfig.userMemoryDir,
	adminUser: serverConfig.adminUser,
	adminPassword: serverConfig.adminPassword,
	secureCookies: serverConfig.secureCookies,
});
const userRuntimes = new Map<string, UserRuntime>();
// Before anything fetches, so model downloads and LLM calls are counted too.
const traffic = await createTrafficMeter({ file: serverConfig.trafficFile, logger });
const localLlmConfig = localLlmConfigs[serverConfig.localLlm];
const llama = await createLlamaService({
	cacheDir: serverConfig.pibotCacheDir,
	modelDir: serverConfig.llamaModelDir,
	modelFile: localLlmConfig.modelFile,
	modelAlias: serverConfig.llamaModelAlias,
	mmprojFile: localLlmConfig.mmprojFile,
	modelDownloadBaseUrl: localLlmConfig.downloadBaseUrl,
	modelLabel: localLlmConfig.name,
	baseUrl: serverConfig.llamaBaseUrl,
	host: serverConfig.llamaHost,
	port: serverConfig.llamaPort,
	contextWindow: serverConfig.llamaContextWindow,
	chatTemplateKwargs: localLlmConfig.chatTemplateKwargs,
	logger,
});
const tts = createTtsService({
	workerKind: serverConfig.qwen3TtsWorker,
	pythonCommand: serverConfig.qwen3TtsPythonCommand,
	pythonWorkerPath: serverConfig.qwen3TtsPythonWorkerPath,
	rustWorkerPath: serverConfig.qwen3TtsRustWorkerPath,
	rustModelPath: serverConfig.qwen3TtsRustModelPath,
	cppWorkerPath: serverConfig.qwen3TtsCppWorkerPath,
	cppModelPath: serverConfig.qwen3TtsCppModelPath,
	logger,
});
const stt = createSttService({
	parakeetCppWorkerPath: serverConfig.parakeetCppWorkerPath,
	parakeetCppModelPath: serverConfig.parakeetCppModelPath,
	sileroVadGgmlModelPath: serverConfig.sileroVadGgmlModelPath,
	logger,
	onEvent: handleSttEvent,
});
const spotify = createSpotifyService({
	fileForUser: (user) => join(auth.userMemoryDirForUser(user), "spotify.json"),
	defaultClientId: serverConfig.spotifyClientId,
	logger,
});
const radio = createRadioService({ logger });
const http = createHttpServer({
	publicDir: serverConfig.publicDir,
	version: serverConfig.version,
	auth,
	spotify,
	radio,
});
traffic.trackServer(http.server);
const websockets = createWebSocketServer({
	server: http.server,
	onClientSocket: (socket, userId) => traffic.attributeToUser(socket, userId),
	logger,
	authenticate: (req) => auth.authenticateRequest(req),
	onEvent: handleWebsocketEvent,
});
sendToUser = websockets.send;

function createRuntimeBase(
	user: AuthenticatedUser,
	harness: RobotHarness,
	robot: RobotClient,
	memoryStore: MemoryStore,
): UserRuntime {
	return {
		user,
		memoryStore,
		radioPlaying: false,
		userId: user.name,
		connected: false,
		robot,
		harness,
		state: sttReady ? { phase: "listening" } : { phase: "inactive" },
		speechActive: false,
		lastSpeechEndedAt: 0,
		stoppedUtteranceIndex: undefined,
		activeChunker: undefined,
		activeAssistantText: "",
		ttsStartedForTurn: false,
		speechPlaybackFinished: undefined,
		resolveSpeechPlaybackFinished: undefined,
		bargeInActive: false,
		activeToolState: undefined,
	};
}

async function getUserRuntime(user: AuthenticatedUser): Promise<UserRuntime> {
	const existing = userRuntimes.get(user.name);
	if (existing) return existing;
	const robot = new RobotClient();
	const memoryStore = createFileMemoryStore(executionEnv, { path: user.memoryFile });
	let runtime: UserRuntime | undefined;
	const harness = await createRobotHarness({
		env: executionEnv,
		logger,
		memoryStore,
		localLlm: serverConfig.localLlm,
		localBaseUrl: serverConfig.llamaBaseUrl,
		localContextWindow: serverConfig.llamaContextWindow,
		maxContextImages: serverConfig.maxContextImages,
		sessionsDir: join(dirname(user.memoryFile), "sessions"),
		robot,
		spotify: async (payload, signal) => {
			const result = await spotify.handle(user.name, payload, signal);
			// The browser shows what is playing; the API calls themselves no longer run there.
			if (result.ok && result.action !== "search") {
				sendToUser(user.name, { type: "spotify_playback", playback: result.title ? result : undefined });
			}
			return result;
		},
		spotifyConnected: async () => (await spotify.status(user.name)).connected,
		radio,
		onEvent: async (event) => {
			if (!runtime?.connected) return;
			await handleHarnessEvent(runtime, event);
		},
		beforeTool: async (name) => {
			if (!runtime?.connected) throw new Error(`tool ${name} blocked because user is not connected`);
			await waitForSpeechBeforeTool(runtime, name);
		},
	});
	runtime = createRuntimeBase(user, harness, robot, memoryStore);
	userRuntimes.set(user.name, runtime);
	return runtime;
}

function logSelectedModel(runtime: UserRuntime): void {
	const model = runtime.harness.model();
	agentLogger.log(
		`[${runtime.userId}] using model ${model.provider}/${model.id} (${model.name}) context=${model.contextWindow}`,
	);
}

function setRobotState(runtime: UserRuntime, state: RobotState): void {
	runtime.state = state;
	sendToUser(runtime.userId, { type: "state", state });
}

function assistantText(runtime: UserRuntime): string {
	return "assistantText" in runtime.state ? runtime.state.assistantText : "";
}

const stopPhrases = [
	"stop",
	"stopp",
	"halt",
	"anhalten",
	"abbrechen",
	"schluss",
	"ruhe",
	"sei still",
	"sei ruhig",
	"hör auf",
	"hoer auf",
	"cancel",
	"enough",
	"be quiet",
	"shut up",
];

function normalizeUtterance(text: string): string {
	return text
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[.,!?;:()[\]{}"'`´]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function looksLikeStopCommand(text: string): boolean {
	const normalized = normalizeUtterance(text);
	if (!normalized) return false;
	for (const phrase of stopPhrases) {
		if (normalized === phrase) return true;
		if (normalized.startsWith(`${phrase} `)) return true;
		if (normalized.endsWith(` ${phrase}`)) return true;
		if (normalized.includes(` ${phrase} `)) return true;
	}
	return false;
}

// While the radio plays, the mic also hears the music. Only speech that addresses the robot (its name,
// or the radio/music itself) becomes a prompt, so sung lyrics are not answered. A bare stop phrase stops
// the radio directly; a stop word inside a longer utterance does not ("don't stop me now").
async function handleFinalWhileRadioPlays(runtime: UserRuntime, text: string): Promise<void> {
	const normalized = normalizeUtterance(text);
	if (stopPhrases.includes(normalized)) {
		sttLogger.log(`[${runtime.userId}] stop phrase while the radio plays: stopping the radio`);
		setRobotState(runtime, { phase: "listening" });
		await runtime.robot
			.execute({ type: "radio", payload: { action: "stop" }, timeoutMs: 5000 })
			.catch((error: unknown) => sttLogger.log(`[${runtime.userId}] radio stop failed: ${String(error)}`));
		return;
	}
	const robotName = (await runtime.memoryStore.list())
		.map((memory) => /\b(?:robot|roboter)\b.*?\b(?:is called|heißt)\s+([^\s.,!?]+)/i.exec(memory)?.[1])
		.find(Boolean);
	const addressed =
		(robotName !== undefined && normalized.includes(normalizeUtterance(robotName))) ||
		/\b(radio|music|station|song|volume|louder|quieter|softer)\b/.test(normalized);
	if (!addressed) {
		sttLogger.log(`[${runtime.userId}] ignored while the radio plays (not addressed): ${JSON.stringify(text)}`);
		setRobotState(runtime, { phase: "listening" });
		return;
	}
	submitPrompt(runtime, text);
}

function submitPrompt(runtime: UserRuntime, text: string): void {
	void runPrompt(runtime, text, false);
}

function assistantMessageText(message: AssistantMessage): string {
	return message.content
		.filter(
			(content): content is Extract<AssistantMessage["content"][number], { type: "text" }> =>
				content.type === "text",
		)
		.map((content) => content.text)
		.join("");
}

async function runPrompt(runtime: UserRuntime, text: string, isContinuation: boolean): Promise<void> {
	setRobotState(runtime, { phase: "thinking", heardText: isContinuation ? undefined : text, assistantText: "" });
	let message: AssistantMessage;
	try {
		message = await runtime.harness.prompt(text);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (message.includes("busy")) {
			sttLogger.log(`[${runtime.userId}] ignored final while agent busy: ${JSON.stringify(text)}`);
			setRobotState(runtime, { phase: "listening" });
			return;
		}
		sttLogger.log(`[${runtime.userId}] prompt failed: ${message}`);
		setRobotState(runtime, { phase: "error", message });
		return;
	}
	if (assistantMessageText(message).trim() || !runtime.connected || runtime.bargeInActive) return;
	if (isContinuation) {
		setRobotState(runtime, { phase: "listening" });
		return;
	}
	agentLogger.log(`[${runtime.userId}] empty settled agent response; requesting continuation`);
	await runPrompt(
		runtime,
		"Internal continuation: your last answer was empty. Answer the user now, briefly and helpfully, in English. If a tool was just executed, briefly confirm the result. Do not call a tool just because of this continuation.",
		true,
	);
}

function handleSttEvent(event: SttEvent): void {
	if (event.type === "ready") {
		sttReady = true;
		sttLogger.log(
			`Parakeet ready sampleRate=${event.sampleRate} vadChunkMs=${event.vadChunkMs} threshold=${event.vadThreshold} energyGate=${event.energyGate ?? "off"} minSilenceMs=${event.minSilenceMs} prerollMs=${event.prerollMs} interimIntervalMs=${event.interimIntervalMs ?? "off"} interimMinAudioMs=${event.interimMinAudioMs ?? "off"} interimWindowMs=${event.interimWindowMs ?? "off"}`,
		);
		for (const runtime of userRuntimes.values()) {
			if (runtime.connected && runtime.state.phase === "inactive") setRobotState(runtime, { phase: "listening" });
		}
		return;
	}
	const runtime = event.userId ? userRuntimes.get(event.userId) : undefined;
	if (!runtime?.connected) {
		if (event.type === "error") sttLogger.log(`error without active user: ${event.message}`);
		return;
	}
	if (event.type === "speech_start") {
		runtime.stoppedUtteranceIndex = undefined;
		sttLogger.log(`[${runtime.userId}] speech_start #${event.index}`);
		setRobotState(runtime, { phase: "hearing" });
	}
	if (event.type === "speech_end") {
		sttLogger.log(`[${runtime.userId}] speech_end #${event.index} duration=${event.duration.toFixed(2)}s`);
	}
	if (event.type === "speech_drop") {
		sttLogger.log(
			`[${runtime.userId}] speech_drop #${event.index} reason=${event.reason} duration=${event.duration.toFixed(2)}s`,
		);
		setRobotState(runtime, { phase: "listening" });
	}
	if (event.type === "interim") {
		sttLogger.log(
			`[${runtime.userId}] interim #${event.index} audioMs=${event.audioMs} windowMs=${event.windowMs ?? "full"} decodeMs=${event.decodeMs} text=${JSON.stringify(event.text)}`,
		);
		if (
			(runtime.speechActive || runtime.bargeInActive) &&
			event.text &&
			looksLikeStopCommand(event.text) &&
			runtime.stoppedUtteranceIndex !== event.index
		) {
			runtime.stoppedUtteranceIndex = event.index;
			sttLogger.log(`[${runtime.userId}] stop-word detected in interim`);
			void abortRobotTurn(runtime, `interim stop word: ${event.text}`);
		}
	}
	if (event.type === "error") setRobotState(runtime, { phase: "error", message: event.message });
	if (event.type === "final") {
		sttLogger.log(
			`[${runtime.userId}] final #${event.index} decodeMs=${event.decodeMs} text=${JSON.stringify(event.text)}`,
		);
		if (runtime.stoppedUtteranceIndex === event.index) {
			runtime.stoppedUtteranceIndex = undefined;
			runtime.bargeInActive = false;
			setRobotState(runtime, { phase: "listening" });
			return;
		}
		if (event.text && looksLikeStopCommand(event.text) && (runtime.speechActive || runtime.bargeInActive)) {
			runtime.stoppedUtteranceIndex = event.index;
			sttLogger.log(`[${runtime.userId}] stop-word detected in final`);
			runtime.bargeInActive = false;
			void abortRobotTurn(runtime, `final stop word: ${event.text}`);
			return;
		}
		if (!event.text) {
			runtime.bargeInActive = false;
			setRobotState(runtime, { phase: "listening" });
			return;
		}
		if (runtime.bargeInActive) {
			runtime.bargeInActive = false;
			if (runtime.state.phase === "tool" || runtime.activeToolState) {
				sttLogger.log(
					`[${runtime.userId}] ignored barge-in final while tool is active: ${JSON.stringify(event.text)}`,
				);
				if (runtime.activeToolState) {
					setRobotState(runtime, {
						phase: "tool",
						name: runtime.activeToolState.name,
						args: runtime.activeToolState.args,
						assistantText: assistantText(runtime),
					});
				} else setRobotState(runtime, { phase: "listening" });
				return;
			}
			submitPrompt(runtime, event.text);
			return;
		}
		if (runtime.speechActive || Date.now() - runtime.lastSpeechEndedAt < 1500) {
			setRobotState(runtime, { phase: "listening" });
			return;
		}
		if (runtime.radioPlaying) {
			void handleFinalWhileRadioPlays(runtime, event.text);
			return;
		}
		submitPrompt(runtime, event.text);
	}
}

function startAssistantSpeechStream(runtime: UserRuntime): void {
	runtime.speechPlaybackFinished = new Promise((resolve) => {
		runtime.resolveSpeechPlaybackFinished = resolve;
	});
	runtime.speechActive = true;
	runtime.ttsStartedForTurn = true;
	setRobotState(runtime, { phase: "speaking", assistantText: runtime.activeAssistantText });
	tts.start(runtime.userId, {
		onStart: (sampleRate) => {
			ttsLogger.log(`[${runtime.userId}] PCM stream start sampleRate=${sampleRate}`);
			if (!runtime.robot.sendTtsStart(sampleRate))
				ttsLogger.log(`[${runtime.userId}] no browser client for TTS start`);
		},
		onAudio: (pcm) => {
			if (!runtime.robot.sendTtsAudio(pcm)) ttsLogger.log(`[${runtime.userId}] no browser client for TTS audio`);
		},
		onDone: () => {
			ttsLogger.log(`[${runtime.userId}] PCM synthesis done`);
			if (!runtime.robot.sendTtsDone()) finishSpeechPlayback(runtime, "no browser client");
		},
		onError: (message) => {
			ttsLogger.log(`[${runtime.userId}] PCM synthesis error: ${message}`);
			runtime.robot.sendTtsError(message);
			finishSpeechPlayback(runtime, `TTS error: ${message}`);
		},
	});
}

function finishSpeechPlayback(runtime: UserRuntime, reason: string, setListening = true): void {
	if (!runtime.speechActive && !runtime.ttsStartedForTurn) return;
	runtime.speechActive = false;
	runtime.ttsStartedForTurn = false;
	runtime.activeChunker = undefined;
	runtime.resolveSpeechPlaybackFinished?.();
	runtime.resolveSpeechPlaybackFinished = undefined;
	runtime.speechPlaybackFinished = undefined;
	ttsLogger.log(`[${runtime.userId}] speech finished: ${reason}`);
	if (!setListening) return;
	runtime.lastSpeechEndedAt = Date.now();
	setRobotState(runtime, { phase: "listening" });
}

async function waitForSpeechBeforeTool(runtime: UserRuntime, name: string): Promise<void> {
	const pendingSpeech = runtime.speechPlaybackFinished;
	if (pendingSpeech) {
		ttsLogger.log(`[${runtime.userId}] waiting for speech before tool ${name}`);
		await pendingSpeech;
	}
	if (runtime.bargeInActive) throw new Error(`tool ${name} blocked by barge-in`);
}

function sanitizeTextForTts(text: string): string {
	return text.replace(/\p{Emoji_Presentation}|\p{Extended_Pictographic}|\uFE0F/gu, " ").replace(/\s+/g, " ");
}

function logToolResult(name: string, result: unknown): void {
	if (name === "spotify_search") agentLogger.log(`spotify_search result ${JSON.stringify(result)}`);
}

function handleAssistantTextDelta(runtime: UserRuntime, text: string): void {
	runtime.activeAssistantText += text;
	setRobotState(runtime, {
		phase: runtime.ttsStartedForTurn ? "speaking" : "thinking",
		assistantText: runtime.activeAssistantText,
	});
	const chunker = runtime.activeChunker;
	if (!chunker) return;
	for (const chunk of chunker.push(sanitizeTextForTts(text))) {
		if (!runtime.ttsStartedForTurn) startAssistantSpeechStream(runtime);
		ttsLogger.log(`[${runtime.userId}] queue text chunk chars=${chunk.length}`);
		tts.pushText(runtime.userId, chunk);
	}
}

async function handleHarnessEvent(runtime: UserRuntime, event: RobotHarnessEvent): Promise<void> {
	if (runtime.bargeInActive) {
		if (event.type === "tool_end") {
			runtime.activeToolState = undefined;
			agentLogger.log(`[${runtime.userId}] tool ${event.name} finished${event.isError ? " with error" : ""}`);
			logToolResult(event.name, event.result);
		}
		if (event.type !== "tool_end") agentLogger.log(`[${runtime.userId}] ignored stale ${event.type} during barge-in`);
		return;
	}
	if (event.type === "assistant_start") {
		runtime.activeAssistantText = "";
		runtime.activeChunker = createSentenceChunker({ sentencesPerChunk: 1 });
		runtime.ttsStartedForTurn = false;
		setRobotState(runtime, { phase: "thinking", assistantText: "" });
	}
	if (event.type === "assistant_delta") handleAssistantTextDelta(runtime, event.text);
	if (event.type === "tool_start") {
		runtime.activeToolState = { name: event.name, args: event.args };
		setRobotState(runtime, {
			phase: "tool",
			name: event.name,
			args: event.args,
			assistantText: assistantText(runtime),
		});
		agentLogger.log(`[${runtime.userId}] tool ${event.name} ${JSON.stringify(event.args)}`);
	}
	if (event.type === "tool_end") {
		runtime.activeToolState = undefined;
		agentLogger.log(`[${runtime.userId}] tool ${event.name} finished${event.isError ? " with error" : ""}`);
		logToolResult(event.name, event.result);
	}
	if (event.type === "assistant_end") {
		if (event.text) agentLogger.log(`[${runtime.userId}] LLM: ${event.text}`);
		else agentLogger.log(`[${runtime.userId}] LLM: <empty assistant response>`);
		if (!runtime.activeAssistantText && event.text) handleAssistantTextDelta(runtime, event.text);
		const tail = runtime.activeChunker?.flush();
		if (tail) {
			if (!runtime.ttsStartedForTurn) startAssistantSpeechStream(runtime);
			ttsLogger.log(`[${runtime.userId}] queue final text chunk chars=${tail.length}`);
			tts.pushText(runtime.userId, tail);
		}
		if (runtime.ttsStartedForTurn) tts.end(runtime.userId);
		else if (event.text) setRobotState(runtime, { phase: "listening" });
	}
	if (event.type === "session_reset") {
		setRobotState(runtime, sttReady ? { phase: "listening" } : { phase: "inactive" });
		agentLogger.log(`[${runtime.userId}] session reset; context cleared`);
	}
}

async function abortRobotTurn(runtime: UserRuntime, reason: string): Promise<void> {
	runtime.bargeInActive = false;
	runtime.activeToolState = undefined;
	agentLogger.log(`[${runtime.userId}] abort: ${reason}`);
	void runtime.robot.execute({ type: "cancel_speech", payload: { reason }, timeoutMs: 1000 }).catch(() => undefined);
	tts.cancelUser(runtime.userId, reason);
	runtime.robot.sendTtsDone();
	finishSpeechPlayback(runtime, `aborted: ${reason}`);
	try {
		await runtime.harness.current().abort();
	} catch (error) {
		agentLogger.log(
			`[${runtime.userId}] harness abort error: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	setRobotState(runtime, { phase: "listening" });
}

async function handleBargeIn(runtime: UserRuntime): Promise<void> {
	const interruptedPhase = runtime.state.phase;
	runtime.bargeInActive = true;
	runtime.lastSpeechEndedAt = 0;
	runtime.stoppedUtteranceIndex = undefined;
	sttLogger.log(`[${runtime.userId}] barge-in detected by client during ${interruptedPhase}`);
	setRobotState(runtime, { phase: "hearing" });
	if (interruptedPhase !== "speaking" && interruptedPhase !== "thinking") return;
	tts.cancelUser(runtime.userId, "barge-in");
	runtime.robot.sendTtsDone();
	finishSpeechPlayback(runtime, "barge-in", false);
	try {
		await runtime.harness.current().abort();
	} catch (error) {
		agentLogger.log(
			`[${runtime.userId}] harness abort error: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (runtime.bargeInActive) setRobotState(runtime, { phase: "hearing" });
}

async function handleWebsocketEvent(event: WebsocketEvent): Promise<void> {
	if (event.type === "client_connected") {
		const runtime = await getUserRuntime(event.user);
		runtime.connected = true;
		runtime.robot.setWebSocket(event.client);
		serverLogger.log(`browser client connected as ${event.userId}`);
		if (runtime.state.phase === "inactive" && sttReady) setRobotState(runtime, { phase: "listening" });
		logSelectedModel(runtime);
		event.client.send(JSON.stringify({ type: "state", state: runtime.state }));
		logger.tag("robot").log(`[${event.userId}] active robot client connected`);
		return;
	}
	const runtime = userRuntimes.get(event.userId);
	if (!runtime) return;
	if (event.type === "client_disconnected") {
		serverLogger.log(`browser client disconnected (${event.userId})`);
		runtime.connected = false;
		stt.closeUser(event.userId);
		tts.cancelUser(event.userId, "browser client disconnected");
		finishSpeechPlayback(runtime, "browser client disconnected");
		runtime.robot.rejectAll("Robot client disconnected");
		runtime.radioPlaying = false;
		return;
	}
	if (event.type === "client_message") {
		const msg = event.message;
		if (msg.type === "client_log") {
			logger.logRaw("client", [...msg.tags, `user:${event.userId}`], msg.message, msg.time);
			return;
		}
		if (runtime.robot.handleMessage(msg)) return;
		if (msg.type === "tts_playback_done") {
			if (runtime.bargeInActive) {
				ttsLogger.log(`[${runtime.userId}] ignored late playback done after barge-in`);
				return;
			}
			finishSpeechPlayback(runtime, "client playback done");
			return;
		}
		if (msg.type === "tts_playback_error") {
			if (runtime.bargeInActive) {
				ttsLogger.log(`[${runtime.userId}] ignored late playback error after barge-in: ${msg.message}`);
				return;
			}
			finishSpeechPlayback(runtime, `client playback error: ${msg.message}`);
			return;
		}
		if (msg.type === "radio_state") {
			if (runtime.radioPlaying !== msg.playing)
				agentLogger.log(`[${runtime.userId}] radio ${msg.playing ? "playing" : "off"}`);
			runtime.radioPlaying = msg.playing;
			return;
		}
		if (msg.type === "abort") await abortRobotTurn(runtime, "client abort");
		if (msg.type === "barge_in") await handleBargeIn(runtime);
		if (msg.type === "reset_session") {
			serverLogger.log(`[${runtime.userId}] session reset: client request`);
			await abortRobotTurn(runtime, "reset: client request");
			await runtime.harness.rebuildSession("client request");
		}
		return;
	}
	if (event.type === "audio_frame") stt.handleAudioFrame(event.userId, event.data);
}

onShutdown(async () => {
	tts.stop();
	stt.stopChildProcess();
	llama.stop();
	for (const runtime of userRuntimes.values()) runtime.robot.stop();
	await traffic.stop();
	await logger.flush();
});

http.server.listen(serverConfig.port, serverConfig.host, () =>
	serverLogger.log(`robot demo: http://${serverConfig.host}:${serverConfig.port}`),
);
