import { dirname, join } from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { RobotState, ServerMessage } from "../types.js";
import {
	type AudioCodec,
	createMicDecoder,
	createSpeechEncoder,
	type MicDecoder,
	type SpeechEncoder,
} from "./audio-codec.js";
import { type AuthenticatedUser, UserAuthService } from "./auth.js";
import { serverConfig } from "./config.js";
import {
	createRobotHarness,
	createSmartModel,
	type RobotHarness,
	type RobotHarnessEvent,
	robotNameFromMemories,
} from "./harness.js";
import { type AccountApi, createHttpServer } from "./http-server.js";
import { createLlamaService, localLlmConfigs } from "./llama.js";
import { createLogger, formatEntry } from "./logger.js";
import { createFileMemoryStore } from "./memory-store.js";
import { createRadioService } from "./radio.js";
import { RobotClient } from "./robot-client.js";
import { createSentenceChunker, type SentenceChunker } from "./sentence-chunker.js";
import { onShutdown } from "./shutdown.js";
import { createSpeechTempo, type SpeechTempo } from "./speech-tempo.js";
import { createSpotifyService } from "./spotify.js";
import { createSttService, type SttEvent } from "./stt.js";
import type { MemoryStore } from "./tools/memory.js";
import { createTrafficMeter } from "./traffic.js";
import { createTtsService } from "./tts.js";
import { createSettingsStore, type UserSettings } from "./user-settings.js";
import { createVoiceLibrary } from "./voices.js";
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
	lastSpeechStartAt: number;
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
	downlinkCodec: AudioCodec;
	micDecoder: MicDecoder | undefined;
	speechEncoder: SpeechEncoder | undefined;
	speechTempo: SpeechTempo | undefined;
	settings: UserSettings;
	voicePath: string;
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
// Creating a runtime loads the saved conversation (async). Two quick connects must share one creation, or
// both copies would append to the same conversation file.
const runtimeCreations = new Map<string, Promise<UserRuntime>>();
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
const settingsStore = createSettingsStore((user) => join(auth.userMemoryDirForUser(user), "settings.json"));
const voices = createVoiceLibrary({ userDir: (user) => auth.userMemoryDirForUser(user) });

async function voicePathFor(user: string, voiceId: string): Promise<string> {
	return (
		(await voices.pathFor(user, voiceId)) ?? (await voices.pathFor(user, voices.defaultId)) ?? tts.defaultVoicePath
	);
}
const smartModelName = createSmartModel()?.name;
const account: AccountApi = {
	profile: async (user) => {
		const memories = await (
			userRuntimes.get(user.name)?.memoryStore ?? createFileMemoryStore(executionEnv, { path: user.memoryFile })
		).list();
		return {
			robotName: robotNameFromMemories(memories),
			settings: await settingsStore.get(user.name),
			brains: { fast: localLlmConfig.name, smart: smartModelName },
		};
	},
	updateSettings: async (user, changes) => {
		let settings = await settingsStore.update(user.name, changes);
		if (!(await voices.pathFor(user.name, settings.voice))) {
			settings = await settingsStore.update(user.name, { voice: voices.defaultId });
		}
		const runtime = userRuntimes.get(user.name);
		if (runtime) {
			runtime.settings = settings;
			runtime.voicePath = await voicePathFor(user.name, settings.voice);
		}
		return settings;
	},
	conversations: async (user) => (await getUserRuntime(user)).harness.conversations(),
	conversation: async (user, id) => (await getUserRuntime(user)).harness.conversation(id),
	newConversation: async (user) => {
		const runtime = await getUserRuntime(user);
		await abortRobotTurn(runtime, "new conversation");
		await runtime.harness.rebuildSession("new conversation");
	},
	openConversation: async (user, id) => {
		const runtime = await getUserRuntime(user);
		await abortRobotTurn(runtime, "conversation switched");
		return runtime.harness.openConversation(id);
	},
};
const http = createHttpServer({
	publicDir: serverConfig.publicDir,
	version: serverConfig.version,
	auth,
	spotify,
	radio,
	account,
	voices,
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
	settings: UserSettings,
	voicePath: string,
): UserRuntime {
	return {
		user,
		memoryStore,
		settings,
		voicePath,
		speechTempo: undefined,
		radioPlaying: false,
		downlinkCodec: "pcm16",
		micDecoder: undefined,
		speechEncoder: undefined,
		userId: user.name,
		connected: false,
		robot,
		harness,
		state: sttReady ? { phase: "listening" } : { phase: "inactive" },
		speechActive: false,
		lastSpeechEndedAt: 0,
		lastSpeechStartAt: 0,
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

function getUserRuntime(user: AuthenticatedUser): Promise<UserRuntime> {
	const existing = userRuntimes.get(user.name);
	if (existing) return Promise.resolve(existing);
	let creation = runtimeCreations.get(user.name);
	if (!creation) {
		creation = createUserRuntime(user).finally(() => runtimeCreations.delete(user.name));
		runtimeCreations.set(user.name, creation);
	}
	return creation;
}

async function createUserRuntime(user: AuthenticatedUser): Promise<UserRuntime> {
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
		conversationsToKeep: serverConfig.conversationsToKeep,
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
		brain: async () => (await settingsStore.get(user.name)).brain,
		radio,
		onEvent: async (event) => {
			if (!runtime?.connected) return;
			await handleHarnessEvent(runtime, event);
		},
		beforeTool: async (name) => {
			if (!runtime?.connected) throw new Error(`tool ${name} blocked because user is not connected`);
			await waitForSpeechBeforeTool(runtime, name);
		},
		beforeModelCall: async () => {
			const pendingSpeech = runtime?.speechPlaybackFinished;
			// Bounded: a client that never reports the end of playback must not stall the conversation.
			if (pendingSpeech) await Promise.race([pendingSpeech, new Promise((resolve) => setTimeout(resolve, 60_000))]);
		},
	});
	const settings = await settingsStore.get(user.name);
	runtime = createRuntimeBase(
		user,
		harness,
		robot,
		memoryStore,
		settings,
		await voicePathFor(user.name, settings.voice),
	);
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

// After the robot spoke, a reply within this window counts as addressed to it even without its name.
const followUpWindowMs = 8000;

// While the radio plays (the mic also hears the music) and in "only respond to my name" mode, only speech
// that addresses the robot becomes a prompt: its name, or with the radio on, the radio/music itself. A bare
// stop phrase stops the radio directly; a stop word inside a longer utterance does not ("don't stop me now").
async function handleAddressedOnly(runtime: UserRuntime, text: string): Promise<void> {
	const normalized = normalizeUtterance(text);
	if (runtime.radioPlaying && stopPhrases.includes(normalized)) {
		sttLogger.log(`[${runtime.userId}] stop phrase while the radio plays: stopping the radio`);
		setRobotState(runtime, { phase: "listening" });
		await runtime.robot
			.execute({ type: "radio", payload: { action: "stop" }, timeoutMs: 5000 })
			.catch((error: unknown) => sttLogger.log(`[${runtime.userId}] radio stop failed: ${String(error)}`));
		return;
	}
	const robotName = robotNameFromMemories(await runtime.memoryStore.list());
	const addressed =
		(robotName !== undefined && normalized.includes(normalizeUtterance(robotName))) ||
		// Name-only mode before setup gave the robot a name: nothing could ever address it, so accept.
		(!runtime.radioPlaying && robotName === undefined) ||
		(runtime.radioPlaying && /\b(radio|music|station|song|volume|louder|quieter|softer)\b/.test(normalized));
	if (!addressed) {
		const why = runtime.radioPlaying ? "while the radio plays" : "in name-only mode";
		sttLogger.log(`[${runtime.userId}] ignored ${why} (not addressed): ${JSON.stringify(text)}`);
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
	if (message.stopReason === "error") {
		// The model call failed (server down, switched away in the dashboard, ...): say so instead of going silent.
		agentLogger.log(`[${runtime.userId}] model error: ${message.errorMessage ?? "unknown"}`);
		if (!runtime.connected) return;
		const unreachable = /connection error|ECONNREFUSED|fetch failed|ENOTFOUND|socket hang up|terminated/i.test(
			message.errorMessage ?? "",
		);
		speakDirect(
			runtime,
			unreachable
				? "Sorry, my language model is not running right now. Please try again in a moment."
				: "Sorry, something went wrong while I was thinking. Please try again.",
		);
		return;
	}
	// Only a normal finish with no text earns a continuation; an aborted turn ("stop") must stay quiet.
	if (assistantMessageText(message).trim() || !runtime.connected || runtime.bargeInActive) return;
	if (message.stopReason !== "stop" && message.stopReason !== "toolUse") return;
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
			if (runtime.connected && (runtime.state.phase === "inactive" || runtime.state.phase === "error")) {
				setRobotState(runtime, { phase: "listening" });
			}
		}
		return;
	}
	if (event.type === "error" && !event.userId) {
		sttLogger.log(`speech recognition error: ${event.message}`);
		for (const runtime of userRuntimes.values()) {
			if (runtime.connected) setRobotState(runtime, { phase: "error", message: event.message });
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
		runtime.lastSpeechStartAt = Date.now();
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
		if (event.text && !runtime.speechActive) sendToUser(runtime.userId, { type: "interim", text: event.text });
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
		// Speech that began while the robot was still talking is its own voice tail or overlap; speech
		// that began after it finished is a real reply, however quickly it came.
		if (runtime.speechActive || runtime.lastSpeechStartAt < runtime.lastSpeechEndedAt) {
			sttLogger.log(`[${runtime.userId}] ignored final that overlapped robot speech: ${JSON.stringify(event.text)}`);
			setRobotState(runtime, { phase: "listening" });
			return;
		}
		const followUp = Date.now() - runtime.lastSpeechEndedAt < followUpWindowMs;
		if (runtime.radioPlaying || (runtime.settings.wakeNameOnly && !followUp)) {
			void handleAddressedOnly(runtime, event.text);
			return;
		}
		submitPrompt(runtime, event.text);
	}
}

function startAssistantSpeechStream(runtime: UserRuntime, voicePath = runtime.voicePath): void {
	runtime.speechPlaybackFinished = new Promise((resolve) => {
		runtime.resolveSpeechPlaybackFinished = resolve;
	});
	runtime.speechActive = true;
	runtime.ttsStartedForTurn = true;
	setRobotState(runtime, { phase: "speaking", assistantText: runtime.activeAssistantText });
	tts.start(
		runtime.userId,
		{
			onStart: (sampleRate) => {
				ttsLogger.log(
					`[${runtime.userId}] PCM stream start sampleRate=${sampleRate} codec=${runtime.downlinkCodec}`,
				);
				runtime.speechEncoder?.close();
				runtime.speechEncoder =
					runtime.downlinkCodec === "opus" &&
					(sampleRate === 16000 || sampleRate === 24000 || sampleRate === 48000)
						? createSpeechEncoder(sampleRate)
						: undefined;
				runtime.speechTempo = createSpeechTempo(runtime.settings.speechRate, sampleRate);
				if (!runtime.robot.sendTtsStart(sampleRate))
					ttsLogger.log(`[${runtime.userId}] no browser client for TTS start`);
			},
			onAudio: (pcm) => {
				if (!sendSpeechAudio(runtime, runtime.speechTempo ? runtime.speechTempo.process(pcm) : pcm)) {
					ttsLogger.log(`[${runtime.userId}] no browser client for TTS audio`);
				}
			},
			onDone: () => {
				ttsLogger.log(`[${runtime.userId}] PCM synthesis done`);
				if (runtime.speechTempo) sendSpeechAudio(runtime, runtime.speechTempo.flush());
				runtime.speechTempo = undefined;
				for (const packet of runtime.speechEncoder?.flush() ?? []) runtime.robot.sendTtsOpus(packet);
				runtime.speechEncoder?.close();
				runtime.speechEncoder = undefined;
				if (!runtime.robot.sendTtsDone()) finishSpeechPlayback(runtime, "no browser client");
			},
			onError: (message) => {
				ttsLogger.log(`[${runtime.userId}] PCM synthesis error: ${message}`);
				runtime.speechEncoder?.close();
				runtime.speechEncoder = undefined;
				runtime.robot.sendTtsError(message);
				finishSpeechPlayback(runtime, `TTS error: ${message}`);
			},
		},
		voicePath,
	);
}

function sendSpeechAudio(runtime: UserRuntime, pcm: Uint8Array): boolean {
	if (pcm.byteLength === 0) return true;
	const encoder = runtime.speechEncoder;
	return encoder
		? encoder.encode(pcm).every((packet) => runtime.robot.sendTtsOpus(packet))
		: runtime.robot.sendTtsAudio(pcm);
}

function speakDirect(runtime: UserRuntime, text: string, voicePath = runtime.voicePath): void {
	runtime.activeAssistantText = text;
	startAssistantSpeechStream(runtime, voicePath);
	tts.pushText(runtime.userId, text);
	tts.end(runtime.userId);
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

// Tools that act in the room (driving, the camera) wait until the robot has finished its sentence. The
// rest (search, radio, memory) run while it is still talking; the next model call waits instead.
const toolsThatWaitForSpeech = new Set(["move_forward", "turn_left", "turn_left_degrees", "take_photo"]);

async function waitForSpeechBeforeTool(runtime: UserRuntime, name: string): Promise<void> {
	const pendingSpeech = toolsThatWaitForSpeech.has(name) ? runtime.speechPlaybackFinished : undefined;
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
		// The socket may have closed (or been replaced) while the runtime was being created.
		if (event.client.readyState !== event.client.OPEN) return;
		runtime.connected = true;
		runtime.robot.setWebSocket(event.client);
		serverLogger.log(`browser client connected as ${event.userId}`);
		if (runtime.state.phase === "inactive" && sttReady) setRobotState(runtime, { phase: "listening" });
		logSelectedModel(runtime);
		event.client.send(JSON.stringify({ type: "state", state: runtime.state }));
		logger.tag("robot").log(`[${event.userId}] active robot client connected`);
		return;
	}
	// Messages can arrive while the runtime is still being created (it loads the saved conversation);
	// wait for it instead of dropping them (e.g. the audio_format sent right after connecting).
	const runtime = userRuntimes.get(event.userId) ?? (await runtimeCreations.get(event.userId));
	if (!runtime) return;
	if (event.type === "client_disconnected") {
		serverLogger.log(`browser client disconnected (${event.userId})`);
		runtime.connected = false;
		stt.closeUser(event.userId);
		tts.cancelUser(event.userId, "browser client disconnected");
		finishSpeechPlayback(runtime, "browser client disconnected");
		runtime.robot.rejectAll("Robot client disconnected");
		runtime.radioPlaying = false;
		runtime.micDecoder?.close();
		runtime.micDecoder = undefined;
		runtime.downlinkCodec = "pcm16";
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
		if (msg.type === "audio_format") {
			runtime.micDecoder?.close();
			runtime.micDecoder = msg.uplink === "opus" ? createMicDecoder() : undefined;
			runtime.downlinkCodec = msg.downlink;
			serverLogger.log(`[${runtime.userId}] audio: mic ${msg.uplink}, speech ${msg.downlink}`);
			return;
		}
		if (msg.type === "mic_flush") {
			stt.flushUser(runtime.userId);
			return;
		}
		if (msg.type === "text_prompt") {
			const text = msg.text.trim().slice(0, 2000);
			if (!text) return;
			// Typing while the robot talks or thinks interrupts it, like speaking over it would.
			if (runtime.state.phase !== "listening" && runtime.state.phase !== "inactive") {
				await abortRobotTurn(runtime, "typed message");
			}
			serverLogger.log(`[${runtime.userId}] typed: ${JSON.stringify(text)}`);
			submitPrompt(runtime, text);
			return;
		}
		if (msg.type === "preview_voice") {
			const voicePath = await voices.pathFor(runtime.userId, msg.voice);
			if (voicePath && !runtime.speechActive) {
				speakDirect(runtime, "Hi! This is how I would sound. Do you like this voice?", voicePath);
			}
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
	if (event.type === "audio_frame") {
		let pcm = event.data;
		if (runtime.micDecoder) {
			try {
				pcm = runtime.micDecoder.decode(event.data);
			} catch (error) {
				sttLogger.log(
					`[${runtime.userId}] dropped bad Opus packet: ${error instanceof Error ? error.message : String(error)}`,
				);
				return;
			}
		}
		stt.handleAudioFrame(event.userId, pcm);
	}
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
