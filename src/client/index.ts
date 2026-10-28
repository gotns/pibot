import type { ClientMessage, RobotState } from "../types.js";
import "./components/robot-face-webgl.js";
import type { RobotFaceState, RobotFaceWebglElement } from "./components/robot-face-webgl.js";
import "./components/robot-log.js";
import type { RobotLogElement } from "./components/robot-log.js";
import "./components/setup-panel.js";
import type { RobotSetupPanelElement } from "./components/setup-panel.js";
import "./components/spotify-panel.js";
import "./components/captions.js";
import type { CaptionsElement } from "./components/captions.js";
import "./components/conversations-panel.js";
import type { ConversationsPanelElement } from "./components/conversations-panel.js";
import "./components/settings-panel.js";

import type { SpotifyNowPlaying } from "../types.js";
import { createCaptureNode } from "./audio-capture.js";
import { BargeInDetector } from "./barge-in.js";
import type { PanelSettings, SettingsPanelElement } from "./components/settings-panel.js";
import type { SpotifyPanelElement } from "./components/spotify-panel.js";
import { BrowserClientLogger } from "./logger.js";
import { createMicLink, detectAudioCodecs, type MicLink, type MicMode } from "./mic-link.js";
import { RobotServer } from "./robot-server.js";
import { createRobotTools } from "./tools/index.js";

const auth = document.querySelector<HTMLElement>("#auth");
const loginForm = document.querySelector<HTMLFormElement>("#loginForm");
const loginName = document.querySelector<HTMLInputElement>("#loginName");
const loginPassword = document.querySelector<HTMLInputElement>("#loginPassword");
const loginError = document.querySelector<HTMLElement>("#loginError");
const setup = document.querySelector<HTMLElement>("#setup");
const robot = document.querySelector<HTMLElement>("#robot");
const logEl = document.querySelector<RobotLogElement>("#log");
const face = document.querySelector<RobotFaceWebglElement>("#face");
const setupFaceHost = document.querySelector<HTMLElement>("#setupFaceHost");
const setupPanel = document.querySelector<RobotSetupPanelElement>("#setupPanel");
const spotifyPanel = document.querySelector<SpotifyPanelElement>("#spotifyPanel");
const spotifyNowPlaying = document.querySelector<HTMLElement>("#spotifyNowPlaying");
const backButton = document.querySelector<HTMLButtonElement>("#back");

if (
	!auth ||
	!loginForm ||
	!loginName ||
	!loginPassword ||
	!loginError ||
	!setup ||
	!robot ||
	!logEl ||
	!face ||
	!setupFaceHost ||
	!setupPanel ||
	!spotifyPanel ||
	!spotifyNowPlaying ||
	!backButton
) {
	throw new Error("Missing required DOM elements");
}

const authSection = auth;
const loginFormElement = loginForm;
const loginNameInput = loginName;
const loginPasswordInput = loginPassword;
const loginErrorElement = loginError;
const robotLog = logEl;
const robotFace = face;
const setupPanelElement = setupPanel;
const spotifyPanelElement = spotifyPanel;
const spotifyNowPlayingElement = spotifyNowPlaying;
const setupSection = setup;
const robotSection = robot;
const setupFaceHostElement = setupFaceHost;

function moveFaceToSetup(): void {
	if (robotFace.parentElement === setupFaceHostElement) return;
	robotFace.classList.add("in-setup");
	setupFaceHostElement.append(robotFace);
}

function moveFaceToRobotMode(): void {
	if (robotFace.parentElement === robotSection) return;
	robotFace.classList.remove("in-setup");
	robotSection.prepend(robotFace);
}

const captionsQuery = document.querySelector<CaptionsElement>("#captions");
const micModeQuery = document.querySelector<HTMLButtonElement>("#micModeButton");
const pttQuery = document.querySelector<HTMLButtonElement>("#pttButton");
const textFormQuery = document.querySelector<HTMLFormElement>("#textForm");
const textInputQuery = document.querySelector<HTMLInputElement>("#textInput");
const conversationsQuery = document.querySelector<ConversationsPanelElement>("#conversationsPanel");
const settingsQuery = document.querySelector<SettingsPanelElement>("#settingsPanel");
const robotNameQuery = document.querySelector<HTMLElement>("#robotName");
const homeSubtitleQuery = document.querySelector<HTMLElement>("#homeSubtitle");
if (
	!captionsQuery ||
	!micModeQuery ||
	!pttQuery ||
	!textFormQuery ||
	!textInputQuery ||
	!conversationsQuery ||
	!settingsQuery ||
	!robotNameQuery ||
	!homeSubtitleQuery
) {
	throw new Error("Missing talk-screen elements");
}
const captions = captionsQuery;
const micModeButton = micModeQuery;
const pttButton = pttQuery;
const textForm = textFormQuery;
const textInput = textInputQuery;
const conversationsPanel = conversationsQuery;
const settingsPanel = settingsQuery;
const robotNameHeading = robotNameQuery;
const homeSubtitle = homeSubtitleQuery;

moveFaceToSetup();
const wsProtocol = location.protocol === "https:" ? "wss" : "ws";
const targetSttSampleRate = 16000;
type ExtendedMicAudioConstraints = MediaTrackConstraints & { latency?: ConstrainDouble };
const micAudioConstraints: ExtendedMicAudioConstraints = {
	echoCancellation: { ideal: true },
	noiseSuppression: { ideal: false },
	autoGainControl: { ideal: false },
	channelCount: { ideal: 1 },
	sampleRate: { ideal: 48000 },
	latency: { ideal: 0.02 },
};
const clientLogger = new BrowserClientLogger();

let robotServer: RobotServer | undefined;
let recognitionWanted = false;
let micStream: MediaStream | undefined;
let micAudioContext: AudioContext | undefined;
let micSource: MediaStreamAudioSourceNode | undefined;
let micCapture: AudioNode | undefined;
// Opus where WebCodecs is available, raw PCM otherwise; known before the first connection completes.
const audioCodecs = detectAudioCodecs();
let micLink: MicLink | undefined;
const micModeKey = "pibot.micMode";
let micMode: MicMode = "auto";
try {
	const saved = localStorage.getItem(micModeKey);
	if (saved === "auto" || saved === "muted" || saved === "push-to-talk") micMode = saved;
} catch {
	// storage unavailable: always listening
}
void audioCodecs.then((codecs) => {
	micLink = createMicLink({
		uplink: codecs.uplink,
		isOpen: () => robotServer?.isOpen() ?? false,
		sendBinary: (data) => robotServer?.sendBinary(data),
		send,
		log: (text) => log(text, "stt"),
		onSendingChange: (sending) => document.body.classList.toggle("mic-sending", sending),
		onUplinkChange: () => void announceAudioFormat(),
	});
	micLink.setMode(micMode);
	log(`audio link: mic ${codecs.uplink}, speech ${codecs.downlink}`, "stt");
});

async function announceAudioFormat(): Promise<void> {
	const codecs = await audioCodecs;
	send({ type: "audio_format", uplink: micLink?.uplinkCodec() ?? codecs.uplink, downlink: codecs.downlink });
}
let serverRobotState: RobotState = { phase: "inactive" };
let currentFaceState: RobotFaceState = "inactive";
let ignoreMicUntil = 0;
let ttsSpeaking = false;
let errorUntil = 0;
let robotStarted = false;
const bargeInDetector = new BargeInDetector(targetSttSampleRate);

function stringifyLogValue(value: unknown): string {
	if (value instanceof Error) return `${value.name}: ${value.message}\n${value.stack ?? ""}`.trim();
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

window.addEventListener("error", (event) => {
	clientLogger.tag("error").log(`window error: ${event.message} at ${event.filename}:${event.lineno}:${event.colno}`);
});
window.addEventListener("unhandledrejection", (event) => {
	clientLogger.tag("error").log(`unhandled rejection: ${stringifyLogValue(event.reason)}`);
});

function log(text: string, tag = ""): void {
	(tag ? clientLogger.tag(tag) : clientLogger).log(text);
}

function send(data: ClientMessage): void {
	robotServer?.send(data);
}

function deriveRobotFaceState(): RobotFaceState {
	if (Date.now() < errorUntil) return "error";
	return serverRobotState.phase;
}

function renderRobotFace(): void {
	const next = deriveRobotFaceState();
	if (next === currentFaceState) return;
	currentFaceState = next;
	robotFace.state = next;
}

function showErrorFor(durationMs: number): void {
	errorUntil = Date.now() + durationMs;
	renderRobotFace();
	setTimeout(renderRobotFace, durationMs + 20);
}

function setTtsSpeaking(active: boolean): void {
	ttsSpeaking = active;
}

function setMicInputBlockedUntil(time: number): void {
	ignoreMicUntil = time;
}

let tools: ReturnType<typeof createRobotTools>;

let nowPlaying: SpotifyNowPlaying | undefined;

function cardButton(label: string, action: () => void | Promise<void>): HTMLButtonElement {
	const button = document.createElement("button");
	button.type = "button";
	button.className = "small";
	button.textContent = label;
	button.addEventListener("click", () => {
		void Promise.resolve(action())
			.catch((error: unknown) => log(`now playing control failed: ${stringifyLogValue(error)}`, "ui"))
			.finally(() => renderSpotifyNowPlaying(nowPlaying));
	});
	return button;
}

// Radio plays in this browser; Spotify is controlled through the server, wherever it plays.
function nowPlayingControls(playback: SpotifyNowPlaying): HTMLElement {
	const controls = document.createElement("div");
	controls.className = "now-playing-controls";
	const signal = new AbortController().signal;
	if (playback.title?.startsWith("Radio: ")) {
		const paused = tools.radio.isPaused();
		controls.append(
			cardButton(paused ? "Resume" : "Pause", async () => {
				await tools.radio.handle({ action: paused ? "resume" : "pause" }, signal);
			}),
			cardButton("Quieter", () => tools.radio.setVolume(tools.radio.volume() - 0.15)),
			cardButton("Louder", () => tools.radio.setVolume(tools.radio.volume() + 0.15)),
			cardButton("Stop", () => tools.radio.stop()),
		);
		return controls;
	}
	const spotifyControl = async (action: "pause" | "resume" | "next") => {
		const response = await fetch("/api/spotify/control", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ action }),
		});
		const data = (await response.json()) as { result?: SpotifyNowPlaying & { ok?: boolean } };
		if (data.result?.ok && data.result.title) nowPlaying = { ...data.result, isPlaying: action !== "pause" };
		else if (action === "pause" && nowPlaying) nowPlaying = { ...nowPlaying, isPlaying: false };
	};
	controls.append(
		cardButton(playback.isPlaying === false ? "Resume" : "Pause", () =>
			spotifyControl(playback.isPlaying === false ? "resume" : "pause"),
		),
		cardButton("Next", () => spotifyControl("next")),
	);
	return controls;
}

function renderSpotifyNowPlaying(playback: SpotifyNowPlaying | undefined): void {
	nowPlaying = playback;
	spotifyNowPlayingElement.hidden = !playback?.title;
	spotifyNowPlayingElement.replaceChildren();
	if (!playback?.title) return;
	if (playback.coverUrl) {
		const image = document.createElement("img");
		image.src = playback.coverUrl;
		image.alt = "cover";
		image.onerror = () => image.remove();
		spotifyNowPlayingElement.append(image);
	}
	const text = document.createElement("div");
	const title = document.createElement("strong");
	title.textContent = playback.title;
	text.append(title);
	if (playback.subtitle) {
		const subtitle = document.createElement("span");
		subtitle.textContent = playback.subtitle;
		text.append(subtitle);
	}
	text.append(nowPlayingControls(playback));
	spotifyNowPlayingElement.append(text);
}

function updateSpotifyPanel(): void {
	spotifyPanelElement.status = tools.spotify.getStatus();
}

tools = createRobotTools({
	logger: clientLogger,
	face: robotFace,
	setMicInputBlockedUntil,
	onSpeakingChange: setTtsSpeaking,
	onPlaybackAudio: (samples, sampleRate) => bargeInDetector.handlePlaybackAudio(samples, sampleRate),
	onSpotifyStatusChange: updateSpotifyPanel,
	onNowPlaying: renderSpotifyNowPlaying,
	onRadioPlayingChange: (playing) => send({ type: "radio_state", playing }),
});
updateSpotifyPanel();
void tools.spotify
	.handleRedirectCallback()
	.then((connected) => {
		if (!connected) return;
		spotifyPanelElement.hidden = false;
		void tools.spotify
			.loadDevices()
			.catch((error: unknown) => log(`Spotify devices failed: ${stringifyLogValue(error)}`, "spotify"));
	})
	.catch((error: unknown) => {
		spotifyPanelElement.hidden = false;
		log(`Spotify login failed: ${stringifyLogValue(error)}`, "spotify");
	});

function initializeRobotServer(): void {
	if (robotServer) return;
	robotServer = new RobotServer({
		url: `${wsProtocol}://${location.host}`,
		logger: clientLogger,
		tools: tools.handlers,
		tts: {
			startPcmStream: tools.speech.startPcmStream,
			pushPcmAudio: tools.speech.pushPcmAudio,
			pushOpusAudio: tools.speech.pushOpusAudio,
			finishPcmStream: tools.speech.finishPcmStream,
			failPcmStream: tools.speech.failPcmStream,
		},
		events: {
			onState: (state) => {
				serverRobotState = state;
				captions.showState(state);
				tools.radio.setDucked(state.phase === "thinking" || state.phase === "tool" || state.phase === "speaking");
				if (state.phase !== "hearing") bargeInDetector.resetStreaming();
				renderRobotFace();
			},
			onLog: (entry) => robotLog.appendLine(entry.origin, entry.tags, entry.message),
			onSpotifyPlayback: renderSpotifyNowPlaying,
			onInterim: (text) => captions.showInterim(text),
			onConnectionChange: handleConnectionChange,
			onReplaced: (reason) =>
				showBanner("connection", `${reason}.`, "Use it here", () => {
					hideBanner("connection");
					robotServer?.reconnectNow();
				}),
			onRejected: (reason) => {
				showErrorFor(5000);
				robotLog.appendLine("client", ["error"], `connection rejected: ${reason}`);
			},
		},
	});
}

clientLogger.setSender((message) => robotServer?.send(message));

function micInputBlocked(): boolean {
	return Date.now() < ignoreMicUntil;
}

function startBargeInStream(preroll: Int16Array): void {
	tools.speech.cancelSpeechForBargeIn();
	setMicInputBlockedUntil(0);
	send({ type: "barge_in" });
	micLink?.send(preroll, true);
	log("barge-in detected; stopped TTS and forwarded mic preroll", "stt");
}

function resampleToPcm16(input: Float32Array, inputSampleRate: number): Int16Array {
	const ratio = inputSampleRate / targetSttSampleRate;
	const outputLength = Math.max(1, Math.floor(input.length / ratio));
	const output = new Int16Array(outputLength);
	for (let i = 0; i < outputLength; i++) {
		const start = Math.floor(i * ratio);
		const end = Math.min(input.length, Math.floor((i + 1) * ratio));
		let sum = 0;
		for (let j = start; j < end; j++) sum += input[j] ?? 0;
		const sample = Math.max(-1, Math.min(1, sum / Math.max(1, end - start)));
		output[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
	}
	return output;
}

function sendMicAudio(input: Float32Array, sampleRate: number): void {
	if (!recognitionWanted || !robotServer?.isOpen()) return;
	const pcm = resampleToPcm16(input, sampleRate);
	const barge = bargeInDetector.observeMic(input, sampleRate, pcm, serverRobotState, ttsSpeaking);
	if (barge.triggered) {
		if (barge.metrics) {
			log(
				`barge metrics rms=${barge.metrics.micRms.toFixed(4)} residual=${barge.metrics.residualRatio.toFixed(3)}`,
				"stt",
			);
		}
		startBargeInStream(barge.preroll ?? new Int16Array());
		return;
	}
	if (bargeInDetector.isStreaming()) {
		micLink?.send(pcm, true);
		return;
	}
	if (!micInputBlocked() && bargeInDetector.shouldStreamMicNormally(serverRobotState)) micLink?.send(pcm, false);
}

async function startRecognition(): Promise<void> {
	if (micStream || micAudioContext) return;
	recognitionWanted = true;
	try {
		micStream = await navigator.mediaDevices.getUserMedia({
			audio: micAudioConstraints,
			video: false,
		});
		const [audioTrack] = micStream.getAudioTracks();
		await audioTrack?.applyConstraints(micAudioConstraints).catch((error: unknown) => {
			log(`mic constraint apply failed: ${error instanceof Error ? error.message : String(error)}`, "stt");
		});
		const settings = audioTrack?.getSettings();
		if (settings) log(`mic settings: ${JSON.stringify(settings)}`, "stt");
		micAudioContext = new AudioContext();
		micSource = micAudioContext.createMediaStreamSource(micStream);
		micCapture = await createCaptureNode(micAudioContext, sendMicAudio);
		micSource.connect(micCapture);
		log(`local STT started: phone PCM -> Parakeet/Silero server, browserRate=${micAudioContext.sampleRate}`, "stt");
	} catch (error) {
		recognitionWanted = false;
		log(`local STT start failed: ${error instanceof Error ? error.message : String(error)}`, "stt");
	}
}

function abortCurrentAgentTurn(): void {
	tools.speech.cancelSpeech("agent turn aborted by touch");
	tools.motor.stopLocalMotorsNow();
	showErrorFor(700);
	send({ type: "abort" });
	setMicInputBlockedUntil(Date.now() + 1500);
	log("agent turn aborted by touch", "stt");
}

const bannerHost = document.querySelector<HTMLElement>("#banners") ?? document.body;

// One notice per key ("connection", "update"), so a reconnect notice never hides an update notice.
function showBanner(key: string, text: string, actionLabel?: string, action?: () => void): void {
	let banner = bannerHost.querySelector<HTMLElement>(`[data-key="${key}"]`);
	if (!banner) {
		banner = document.createElement("div");
		banner.className = "banner";
		banner.dataset.key = key;
		banner.setAttribute("role", "status");
		bannerHost.append(banner);
	}
	const message = document.createElement("span");
	message.textContent = text;
	const children: Node[] = [message];
	if (actionLabel && action) {
		const button = document.createElement("button");
		button.textContent = actionLabel;
		button.addEventListener("click", action);
		children.push(button);
	}
	banner.replaceChildren(...children);
}

function hideBanner(key: string): void {
	bannerHost.querySelector(`[data-key="${key}"]`)?.remove();
}

let reloadVersion: string | undefined;
let autoReloadPending = false;

function robotModeActive(): boolean {
	return !robotSection.hidden;
}

function requestAutoReload(reason: string): void {
	if (robotModeActive()) {
		if (!autoReloadPending) log(`Auto-reload deferred while robot mode is active: ${reason}`, "reload");
		autoReloadPending = true;
		showBanner("update", "pibot was updated.", "Reload", () => location.reload());
		return;
	}
	location.reload();
}

function reloadIfPending(): void {
	if (!autoReloadPending || robotModeActive()) return;
	location.reload();
}

// The server version changes on every restart. Checked on each (re)connect instead of polling, so an idle
// tab costs no requests; a restart always drops the connection, so the check runs right after it.
async function checkServerVersion(): Promise<void> {
	try {
		const response = await fetch("/__version", { cache: "no-store" });
		const data = (await response.json()) as { version?: string };
		if (!data.version) return;
		if (!reloadVersion) {
			reloadVersion = data.version;
			return;
		}
		if (data.version !== reloadVersion) requestAutoReload("server version changed");
	} catch (error) {
		clientLogger.tag("debug").log(`version check failed: ${error instanceof Error ? error.message : String(error)}`);
	}
}

void checkServerVersion();

let disconnectedBannerTimer: ReturnType<typeof setTimeout> | undefined;

function handleConnectionChange(connected: boolean): void {
	clearTimeout(disconnectedBannerTimer);
	if (connected) {
		hideBanner("connection");
		// A new connection means a new decoder on the server: restart the encoder and say how audio flows.
		micLink?.reset();
		void announceAudioFormat();
		void checkServerVersion();
		return;
	}
	// Brief blips reconnect silently; say something only if it takes longer.
	disconnectedBannerTimer = setTimeout(() => showBanner("connection", "Reconnecting to pibot..."), 2000);
	if ((robotServer?.failedAttempts() ?? 0) >= 3) {
		void fetch("/api/me", { cache: "no-store" })
			.then((response) => {
				if (response.status === 401) showLogin("Your login expired. Please sign in again.");
			})
			.catch(() => undefined);
	}
}

function showLogin(message = ""): void {
	authSection.hidden = false;
	setupSection.hidden = true;
	robotSection.hidden = true;
	loginErrorElement.textContent = message;
}

function showSetupAfterLogin(): void {
	authSection.hidden = true;
	setupSection.hidden = false;
	robotSection.hidden = true;
	moveFaceToSetup();
	initializeRobotServer();
	void loadProfile();
}

async function checkExistingSession(): Promise<void> {
	try {
		const response = await fetch("/api/me", { cache: "no-store" });
		if (!response.ok) {
			showLogin();
			return;
		}
		showSetupAfterLogin();
	} catch (error) {
		showLogin(error instanceof Error ? error.message : String(error));
	}
}

loginFormElement.addEventListener("submit", (event) => {
	event.preventDefault();
	loginErrorElement.textContent = "";
	void fetch("/api/login", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ name: loginNameInput.value, password: loginPasswordInput.value }),
	})
		.then(async (response) => {
			if (response.ok) {
				loginPasswordInput.value = "";
				showSetupAfterLogin();
				return;
			}
			const body = (await response.json().catch(() => undefined)) as { error?: string } | undefined;
			showLogin(body?.error ?? "Login failed");
		})
		.catch((error: unknown) => showLogin(error instanceof Error ? error.message : String(error)));
});

void checkExistingSession();

async function enterRobotMode(): Promise<void> {
	moveFaceToRobotMode();
	setupSection.hidden = true;
	robotSection.hidden = false;
	void keepScreenOn(true);
	try {
		if (!document.fullscreenElement) await document.documentElement.requestFullscreen();
	} catch (error) {
		log(`Fullscreen request failed: ${error instanceof Error ? error.message : String(error)}`);
	}
}

async function startRobot(): Promise<void> {
	if (robotStarted) {
		void enterRobotMode();
		return;
	}
	setupPanelElement.mode = "starting";
	// Still inside the Start tap: lets the radio start later without another tap (iOS).
	tools.radio.unlock();
	try {
		tools.speech.enableTts();
		log("TTS enabled: Qwen3 local clone", "stt");
		// A robot paired earlier reconnects silently; pairing a new one is "Connect robot" in Settings.
		robotConnected = await tools.motor.connectFt232h(false);
		if (robotConnected) await startCompass();
		else log("No robot hardware connected; driving tools will report errors", "hardware");
		log("Camera will open on demand for photos", "camera");
		await startRecognition();
		robotStarted = true;
		setupPanelElement.mode = "started";
		await enterRobotMode();
	} catch (error) {
		robotStarted = false;
		setupPanelElement.mode = "idle";
		throw error;
	}
}

setupPanelElement.addEventListener("start-robot", () => void startRobot());
function openSpotifyPanel(): void {
	spotifyPanelElement.hidden = false;
	spotifyPanelElement.scrollIntoView({ behavior: "smooth", block: "start" });
	void tools.spotify
		.refreshStatus()
		.then(() => (tools.spotify.getStatus().connected ? tools.spotify.loadDevices() : undefined))
		.catch((error: unknown) => log(`Spotify status failed: ${stringifyLogValue(error)}`, "spotify"));
}
spotifyPanelElement.addEventListener("spotify-close", () => {
	spotifyPanelElement.hidden = true;
});
spotifyPanelElement.addEventListener("spotify-client-id", (event) => {
	const detail = (event as CustomEvent<{ clientId: string }>).detail;
	if (detail.clientId.trim() === tools.spotify.getStatus().clientId) return;
	void tools.spotify
		.setClientId(detail.clientId)
		.catch((error: unknown) => log(`Spotify client ID failed: ${stringifyLogValue(error)}`, "spotify"));
});
spotifyPanelElement.addEventListener("spotify-connect", () => {
	void tools.spotify
		.login()
		.catch((error: unknown) => log(`Spotify login failed: ${stringifyLogValue(error)}`, "spotify"));
});
spotifyPanelElement.addEventListener("spotify-disconnect", () => {
	void tools.spotify
		.disconnect()
		.catch((error: unknown) => log(`Spotify disconnect failed: ${stringifyLogValue(error)}`, "spotify"));
});
spotifyPanelElement.addEventListener("spotify-refresh-devices", () => {
	void tools.spotify
		.loadDevices()
		.catch((error: unknown) => log(`Spotify devices failed: ${stringifyLogValue(error)}`, "spotify"));
});
spotifyPanelElement.addEventListener("spotify-device", (event) => {
	const detail = (event as CustomEvent<{ deviceId?: string }>).detail;
	void tools.spotify
		.selectDevice(detail.deviceId)
		.catch((error: unknown) => log(`Spotify device failed: ${stringifyLogValue(error)}`, "spotify"));
});
spotifyPanelElement.addEventListener("spotify-browser-player", () => {
	void tools.spotify
		.startBrowserPlayer()
		.then(updateSpotifyPanel)
		.catch((error: unknown) => log(`Spotify browser player failed: ${stringifyLogValue(error)}`, "spotify"));
});

function leaveRobotMode(): void {
	robotSection.hidden = true;
	setupSection.hidden = false;
	moveFaceToSetup();
	void keepScreenOn(false);
	// The robot may have learned its name or your name in this conversation.
	void loadProfile();
	reloadIfPending();
}

backButton.onclick = async () => {
	leaveRobotMode();
	try {
		if (document.fullscreenElement) await document.exitFullscreen();
	} catch (error) {
		log(`Fullscreen exit failed: ${error instanceof Error ? error.message : String(error)}`);
	}
};

document.addEventListener("fullscreenchange", () => {
	if (!document.fullscreenElement && !robot.hidden) leaveRobotMode();
});

function handleRobotTouch(event: PointerEvent): void {
	// Controls do their own thing; a tap anywhere else (the face) interrupts the robot.
	if (event.target instanceof Element && event.target.closest(".talk-bar, #back, #spotifyNowPlaying")) return;
	event.preventDefault();
	abortCurrentAgentTurn();
}

robotSection.addEventListener("pointerdown", handleRobotTouch);

setupPanelElement.addEventListener("logout", () => {
	void fetch("/api/logout", { method: "POST" })
		.then(() => location.reload())
		.catch((error: unknown) => log(`logout failed: ${stringifyLogValue(error)}`, "ui"));
});

// --- Profile: the robot's name and this account's settings -------------------------------------------

interface Profile {
	robotName?: string;
	settings: PanelSettings;
	brains: { fast: string; smart?: string };
}

let profile: Profile | undefined;
let robotConnected = false;

function robotDisplayName(): string {
	return profile?.robotName ?? "Pipi";
}

async function loadProfile(): Promise<void> {
	try {
		const response = await fetch("/api/me", { cache: "no-store" });
		if (!response.ok) return;
		profile = (await response.json()) as Profile;
	} catch {
		return;
	}
	applyProfile();
}

function applyProfile(): void {
	const name = robotDisplayName();
	robotNameHeading.textContent = name;
	document.title = name;
	setupPanelElement.robotName = name;
	homeSubtitle.textContent = profile?.settings.wakeNameOnly
		? `Say "${name}" to get its attention`
		: "Your voice assistant";
	tools.speech.setVoiceEffect(profile?.settings.voiceEffect ?? true);
}

// --- Robot hardware (optional) --------------------------------------------------------------------

async function startCompass(): Promise<void> {
	await tools.motor
		.startOrientationTracking()
		.catch((error) =>
			log(`Orientation tracking failed: ${error instanceof Error ? error.message : String(error)}`, "orientation"),
		);
}

async function connectRobot(): Promise<void> {
	robotConnected = await tools.motor.connectFt232h(true);
	if (robotConnected) await startCompass();
	showBanner(
		"robot",
		robotConnected ? "Robot connected." : "No robot connected. Driving needs an FT232H adapter and Chrome or Edge.",
	);
	setTimeout(() => hideBanner("robot"), 5000);
}

// --- Keep the screen on while talking ---------------------------------------------------------------

let wakeLock: WakeLockSentinel | undefined;

async function keepScreenOn(on: boolean): Promise<void> {
	try {
		if (on && !wakeLock && "wakeLock" in navigator) {
			wakeLock = await navigator.wakeLock.request("screen");
			wakeLock.addEventListener("release", () => {
				wakeLock = undefined;
			});
		} else if (!on && wakeLock) {
			await wakeLock.release();
			wakeLock = undefined;
		}
	} catch (error) {
		log(`screen wake lock unavailable: ${error instanceof Error ? error.message : String(error)}`, "ui");
	}
}

// The browser drops the lock when the page is hidden; take it again on return.
document.addEventListener("visibilitychange", () => {
	if (document.visibilityState === "visible" && robotModeActive()) void keepScreenOn(true);
});

// --- Mic mode: always listening, muted, or hold to talk -----------------------------------------------

const micModeOrder: MicMode[] = ["auto", "muted", "push-to-talk"];
const micModeText: Record<MicMode, string> = {
	auto: "Listening. Tap to mute.",
	muted: "Muted. Tap for hold to talk.",
	"push-to-talk": "Hold to talk. Tap to listen all the time.",
};
const micIcon =
	'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>';
const mutedIcon =
	'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 9.3V6a3 3 0 0 0-5.7-1.3M9 9v3a3 3 0 0 0 4.9 2.3"/><path d="M5 11a7 7 0 0 0 11.6 5.3M19 11a7 7 0 0 1-.6 2.8M12 18v3M4 4l16 16"/></svg>';
const handIcon =
	'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V12M11 11V4.5a1.5 1.5 0 0 1 3 0V11M14 11V6.5a1.5 1.5 0 0 1 3 0v7.5a6 6 0 0 1-6 6h-.6a6 6 0 0 1-4.7-2.3L3.5 15a1.5 1.5 0 0 1 2.3-1.9L8 15"/></svg>';

function applyMicMode(): void {
	micLink?.setMode(micMode);
	micModeButton.dataset.mode = micMode;
	micModeButton.setAttribute("aria-label", micModeText[micMode]);
	micModeButton.title = micModeText[micMode];
	micModeButton.innerHTML = micMode === "auto" ? micIcon : micMode === "muted" ? mutedIcon : handIcon;
	pttButton.hidden = micMode !== "push-to-talk";
	try {
		localStorage.setItem(micModeKey, micMode);
	} catch {
		// storage unavailable: the mode still applies on this page
	}
}

micModeButton.addEventListener("click", () => {
	micMode = micModeOrder[(micModeOrder.indexOf(micMode) + 1) % micModeOrder.length] ?? "auto";
	applyMicMode();
});

function setPushToTalk(talking: boolean): void {
	micLink?.setPushToTalk(talking);
	pttButton.classList.toggle("active", talking);
	pttButton.textContent = talking ? "Listening..." : "Hold to talk";
}

pttButton.addEventListener("pointerdown", (event) => {
	event.preventDefault();
	pttButton.setPointerCapture(event.pointerId);
	setPushToTalk(true);
});
pttButton.addEventListener("pointerup", () => setPushToTalk(false));
pttButton.addEventListener("pointercancel", () => setPushToTalk(false));
// Space bar works too, unless you are typing.
document.addEventListener("keydown", (event) => {
	if (
		event.code === "Space" &&
		!event.repeat &&
		micMode === "push-to-talk" &&
		robotModeActive() &&
		event.target !== textInput
	) {
		event.preventDefault();
		setPushToTalk(true);
	}
});
document.addEventListener("keyup", (event) => {
	if (event.code === "Space" && micMode === "push-to-talk" && event.target !== textInput) setPushToTalk(false);
});
applyMicMode();

// --- Typing instead of talking ----------------------------------------------------------------------

textForm.addEventListener("submit", (event) => {
	event.preventDefault();
	const text = textInput.value.trim();
	if (!text) return;
	if (!robotServer?.isOpen()) {
		showBanner("connection", "Not connected to pibot yet. Try again in a moment.");
		return;
	}
	send({ type: "text_prompt", text });
	captions.showTyped(text);
	textInput.value = "";
});

// --- Panels on the home screen ----------------------------------------------------------------------

setupPanelElement.addEventListener("open-conversations", () => {
	settingsPanel.hidden = true;
	void conversationsPanel.open();
});
conversationsPanel.addEventListener("conversation-changed", () => captions.clear());

setupPanelElement.addEventListener("open-settings", () => {
	conversationsPanel.hidden = true;
	if (!profile) return;
	void settingsPanel.open({
		robotName: robotDisplayName(),
		settings: profile.settings,
		brains: profile.brains,
		radioVolume: tools.radio.volume(),
		showLog: !robotLog.hidden,
		robotConnected,
	});
});
settingsPanel.addEventListener("settings-changed", (event) => {
	if (!profile) return;
	profile.settings = (event as CustomEvent<PanelSettings>).detail;
	applyProfile();
});
settingsPanel.addEventListener("preview-voice", (event) => {
	tools.speech.unlock();
	tools.speech.enableTts();
	send({ type: "preview_voice", voice: (event as CustomEvent<string>).detail });
});
settingsPanel.addEventListener("radio-volume", (event) => tools.radio.setVolume((event as CustomEvent<number>).detail));
settingsPanel.addEventListener("open-spotify", () => openSpotifyPanel());
settingsPanel.addEventListener("connect-robot", () => void connectRobot());

// The technical log is for debugging; off unless switched on in Settings.
const showLogKey = "pibot.showLog";
try {
	robotLog.hidden = localStorage.getItem(showLogKey) !== "true";
} catch {
	robotLog.hidden = true;
}
settingsPanel.addEventListener("show-log", (event) => {
	const show = (event as CustomEvent<boolean>).detail;
	robotLog.hidden = !show;
	try {
		localStorage.setItem(showLogKey, String(show));
	} catch {
		// storage unavailable: applies to this page only
	}
});
