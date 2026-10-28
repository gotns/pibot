import { type ChildProcess, spawn } from "node:child_process";
import { type Dirent, existsSync } from "node:fs";
import { mkdir, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { downloadFile } from "./download.js";
import type { Logger } from "./logger.js";

const workerInputSpeak = 1;
const workerInputShutdown = 3;
// Payload: reference WAV path; switches the cloned voice for the requests that follow (C++ worker only).
const workerInputSetVoice = 4;
const workerOutputReady = 1;
const workerOutputAudioStart = 2;
const workerOutputAudioChunk = 3;
const workerOutputAudioDone = 4;
const workerOutputError = 5;
const frameHeaderBytes = 9;
const defaultRustTtsModelRepo = "mlx-community/Qwen3-TTS-12Hz-0.6B-Base-6bit";
const defaultCppTtsModelRepo = "badlogicgames/qwen3-tts-0.6b-q8_0-gguf";
const ignoredHuggingFaceFiles = new Set([".gitattributes", "README.md"]);
const requiredRustTtsModelFiles = [
	"config.json",
	"model.safetensors",
	"vocab.json",
	"merges.txt",
	"speech_tokenizer/model.safetensors",
] as const;
const requiredCppTtsModelFiles = ["qwen3-tts-0.6b-q8_0.gguf", "qwen3-tts-tokenizer-f16.gguf"] as const;

type TtsWorkerKind = "disabled" | "python" | "rust" | "cpp";

export interface TtsServiceDeps {
	workerKind: string;
	pythonCommand: string;
	pythonWorkerPath: string;
	rustWorkerPath: string | undefined;
	rustModelPath: string | undefined;
	cppWorkerPath: string | undefined;
	cppModelPath: string | undefined;
	logger: Logger;
}

export interface TtsCallbacks {
	onStart: (sampleRate: number) => void;
	onAudio: (pcm: Uint8Array) => void;
	onDone: () => void;
	onError: (message: string) => void;
}

export interface TtsService {
	ready: Promise<void>;
	start: (userId: string, callbacks: TtsCallbacks, voicePath?: string) => void;
	defaultVoicePath: string;
	pushText: (userId: string, text: string) => void;
	end: (userId: string) => void;
	cancelUser: (userId: string, reason: string) => void;
	cancel: (reason: string) => void;
	stop: () => void;
}

interface QueuedRequest {
	id: number;
	userId: string;
	text: string;
	voicePath: string;
}

interface ActiveRequest extends QueuedRequest {
	cancelled: boolean;
}

interface TtsTurn {
	callbacks: TtsCallbacks;
	voicePath: string;
	pendingRequests: number;
	turnEnded: boolean;
	streamStarted: boolean;
	cancelled: boolean;
}

function envNumber(name: string, fallback: number): number {
	const value = process.env[name];
	if (value === undefined || value.trim() === "") return fallback;
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) throw new Error(`${name} must be a number`);
	return parsed;
}

function makeFrame(type: number, id: number, payload: Uint8Array = new Uint8Array()): Buffer {
	const frame = Buffer.allocUnsafe(frameHeaderBytes + payload.byteLength);
	frame.writeUInt8(type, 0);
	frame.writeUInt32LE(id >>> 0, 1);
	frame.writeUInt32LE(payload.byteLength, 5);
	Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength).copy(frame, frameHeaderBytes);
	return frame;
}

function decodeUtf8(payload: Uint8Array): string {
	return Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength).toString("utf8");
}

function parseWorkerKind(value: string): TtsWorkerKind {
	if (value === "disabled" || value === "python" || value === "rust" || value === "cpp") return value;
	throw new Error(`QWEN3_TTS_WORKER must be disabled, python, rust, or cpp, got ${value}`);
}

function shouldLogQwen3Line(line: string): boolean {
	if (line.startsWith("{")) return true;
	if (/^(ready|cancel:|error|failed|traceback)/i.test(line)) return true;
	if (
		/^(ICL voice clone|Reference text:|Synthesis text:|Reference codec frames:|ref_text tokens:|Building ICL|Built ICL|Generating audio codes|Generated \d+ code frames|Streaming decode|Streaming codes tensor shape:|Streaming vocoder output shape:|EOS detected)/.test(
			line,
		)
	) {
		return false;
	}
	if (/^(Loaded|Loading|Found |Audio encoder input:|After |Before |Encoded codes:|Encoded \d+ frames)/.test(line))
		return false;
	return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function huggingFaceFileUrl(repo: string, file: string): string {
	return `https://huggingface.co/${repo}/resolve/main/${file.split("/").map(encodeURIComponent).join("/")}`;
}

async function hasUsableFile(path: string): Promise<boolean> {
	try {
		return (await stat(path)).size > 0;
	} catch {
		return false;
	}
}

async function hasRequiredModelFiles(modelDir: string, files: readonly string[]): Promise<boolean> {
	for (const file of files) {
		if (!(await hasUsableFile(join(modelDir, file)))) return false;
	}
	return true;
}

async function listHuggingFaceFiles(repo: string): Promise<string[]> {
	const response = await fetch(`https://huggingface.co/api/models/${repo}`);
	if (!response.ok) throw new Error(`failed to list ${repo}: HTTP ${response.status}`);
	const value: unknown = await response.json();
	if (!isRecord(value) || !Array.isArray(value.siblings))
		throw new Error(`invalid Hugging Face model API response for ${repo}`);
	const files: string[] = [];
	for (const sibling of value.siblings) {
		if (!isRecord(sibling) || typeof sibling.rfilename !== "string") continue;
		files.push(sibling.rfilename);
	}
	return files;
}

async function cleanupStaleDownloads(dir: string): Promise<void> {
	let entries: Dirent[];
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			await cleanupStaleDownloads(path);
			continue;
		}
		if (entry.isFile() && entry.name.includes(".tmp-")) await unlink(path).catch(() => undefined);
	}
}

async function ensureHuggingFaceModel(
	modelDir: string,
	repo: string,
	requiredFiles: readonly string[],
	label: string,
	logger: Logger,
): Promise<void> {
	await mkdir(modelDir, { recursive: true });
	await cleanupStaleDownloads(modelDir);
	if (await hasRequiredModelFiles(modelDir, requiredFiles)) return;

	logger.log(`provisioning ${label} model ${repo} into ${modelDir}`);
	const files = (await listHuggingFaceFiles(repo)).filter((file) => !ignoredHuggingFaceFiles.has(file));
	for (const file of files) {
		const path = join(modelDir, file);
		if (await hasUsableFile(path)) continue;
		await downloadFile(huggingFaceFileUrl(repo, file), path, `${label} model file ${file}`, logger);
	}

	if (!(await hasRequiredModelFiles(modelDir, requiredFiles))) {
		throw new Error(`${label} model is incomplete after download: ${modelDir}`);
	}
}

export function createTtsService(deps: TtsServiceDeps): TtsService {
	const workerKind = parseWorkerKind(deps.workerKind);
	if (workerKind === "disabled") return createDisabledTtsService(deps.logger);

	const qwen3ModelName = process.env.QWEN3_TTS_MODEL_NAME ?? "mlx-community/Qwen3-TTS-12Hz-0.6B-Base-6bit";
	const qwen3RefAudio = process.env.QWEN3_TTS_REF_AUDIO ?? "data/voices/elevenlabs-pibot-reference-de.wav";
	const qwen3RefTextFile = process.env.QWEN3_TTS_REF_TEXT_FILE ?? "data/voices/elevenlabs-pibot-reference-de.txt";
	const qwen3Language = process.env.QWEN3_TTS_LANGUAGE ?? "de";
	const qwen3OutputSampleRate = envNumber("QWEN3_TTS_OUTPUT_SAMPLE_RATE", 24000);
	const qwen3Blocksize = envNumber("QWEN3_TTS_BLOCKSIZE", Math.round(qwen3OutputSampleRate * 0.2));
	const qwen3Temperature = envNumber("QWEN3_TTS_TEMPERATURE", 0.7);
	const qwen3TopK = envNumber("QWEN3_TTS_TOP_K", 30);
	const qwen3Seed = process.env.QWEN3_TTS_SEED ?? "1234";

	const logger = deps.logger.tag("tts");
	const qwen3Logger = logger.tag("qwen3");
	const textEncoder = new TextEncoder();
	const queue: QueuedRequest[] = [];
	const turns = new Map<string, TtsTurn>();
	let worker: ChildProcess | undefined;
	let stdoutBuffer = Buffer.alloc(0);
	let nextRequestId = 1;
	let lastServedUserId: string | undefined;
	let activeRequest: ActiveRequest | undefined;
	let resolveReady: (() => void) | undefined;
	let rejectReady: ((error: Error) => void) | undefined;
	let stopping = false;
	let restartAttempts = 0;
	// The voice the worker currently speaks with; it starts with the --ref-audio voice.
	let workerVoicePath = qwen3RefAudio;
	const voiceRequestIds = new Map<number, string>();
	const restartDelaysMs = [1000, 2000, 5000, 10000, 30000];

	const ready = new Promise<void>((resolve, reject) => {
		resolveReady = resolve;
		rejectReady = reject;
	});

	function sendFrame(type: number, id: number, payload?: Uint8Array): void {
		if (!worker?.stdin || worker.stdin.destroyed) throw new Error("Qwen3 TTS worker is not available");
		worker.stdin.write(makeFrame(type, id, payload));
	}

	function userHasQueuedRequest(userId: string): boolean {
		return queue.some((request) => request.userId === userId) || activeRequest?.userId === userId;
	}

	function finishTurnIfIdle(userId: string): void {
		const turn = turns.get(userId);
		if (!turn || !turn.turnEnded || turn.pendingRequests > 0 || userHasQueuedRequest(userId)) return;
		turns.delete(userId);
		turn.callbacks.onDone();
	}

	function failTurn(userId: string, message: string): void {
		const turn = turns.get(userId);
		if (!turn) return;
		turns.delete(userId);
		turn.callbacks.onError(message);
	}

	function takeNextQueuedRequest(): QueuedRequest | undefined {
		if (queue.length === 0) return undefined;
		if (!lastServedUserId) return queue.shift();
		const nextUserIndex = queue.findIndex((request) => request.userId !== lastServedUserId);
		if (nextUserIndex < 0) return queue.shift();
		return queue.splice(nextUserIndex, 1)[0];
	}

	function pump(): void {
		if (activeRequest) return;
		const request = takeNextQueuedRequest();
		if (!request) return;
		lastServedUserId = request.userId;
		activeRequest = { ...request, cancelled: false };
		try {
			if (workerKind === "cpp" && request.voicePath !== workerVoicePath) {
				const voiceRequestId = nextRequestId++;
				voiceRequestIds.set(voiceRequestId, request.voicePath);
				sendFrame(workerInputSetVoice, voiceRequestId, textEncoder.encode(request.voicePath));
				workerVoicePath = request.voicePath;
			}
			sendFrame(workerInputSpeak, request.id, textEncoder.encode(request.text));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			activeRequest = undefined;
			failTurn(request.userId, message);
			pump();
		}
	}

	function handleWorkerFrame(type: number, id: number, payload: Uint8Array): void {
		if (type === workerOutputReady) {
			qwen3Logger.log("ready");
			restartAttempts = 0;
			resolveReady?.();
			resolveReady = undefined;
			return;
		}
		const failedVoice = voiceRequestIds.get(id);
		if (failedVoice !== undefined) {
			// The worker kept its previous voice; make the next request for this voice try again.
			voiceRequestIds.delete(id);
			logger.log(`voice switch failed (${failedVoice}): ${decodeUtf8(payload)}`);
			if (workerVoicePath === failedVoice) workerVoicePath = "";
			return;
		}
		const request = activeRequest;
		if (!request || id !== request.id) return;
		const turn = turns.get(request.userId);
		if (request.cancelled) {
			if (type === workerOutputAudioDone || type === workerOutputError) {
				activeRequest = undefined;
				pump();
			}
			return;
		}
		if (!turn || turn.cancelled) {
			if (type === workerOutputAudioDone || type === workerOutputError) {
				if (turn) turns.delete(request.userId);
				activeRequest = undefined;
				pump();
			}
			return;
		}
		if (type === workerOutputAudioStart) {
			if (!turn.streamStarted) {
				turn.streamStarted = true;
				const sampleRate = payload.byteLength >= 4 ? Buffer.from(payload).readUInt32LE(0) : qwen3OutputSampleRate;
				turn.callbacks.onStart(sampleRate);
			}
			return;
		}
		if (type === workerOutputAudioChunk) {
			turn.callbacks.onAudio(payload);
			return;
		}
		if (type === workerOutputAudioDone) {
			turn.pendingRequests = Math.max(0, turn.pendingRequests - 1);
			activeRequest = undefined;
			finishTurnIfIdle(request.userId);
			pump();
			return;
		}
		if (type === workerOutputError) {
			activeRequest = undefined;
			failTurn(request.userId, decodeUtf8(payload));
			pump();
		}
	}

	function handleStdoutData(chunk: Buffer): void {
		stdoutBuffer = Buffer.concat([stdoutBuffer, chunk]);
		while (stdoutBuffer.byteLength >= frameHeaderBytes) {
			const type = stdoutBuffer.readUInt8(0);
			const id = stdoutBuffer.readUInt32LE(1);
			const payloadLength = stdoutBuffer.readUInt32LE(5);
			const frameLength = frameHeaderBytes + payloadLength;
			if (stdoutBuffer.byteLength < frameLength) return;
			const payload = stdoutBuffer.subarray(frameHeaderBytes, frameLength);
			stdoutBuffer = stdoutBuffer.subarray(frameLength);
			handleWorkerFrame(type, id, payload);
		}
	}

	function workerCommand(): { command: string; args: string[]; label: string } {
		const commonArgs = [
			"--serve",
			"--ref-audio",
			qwen3RefAudio,
			"--ref-text-file",
			qwen3RefTextFile,
			"--language",
			qwen3Language,
			"--output-sample-rate",
			String(qwen3OutputSampleRate),
			"--blocksize",
			String(qwen3Blocksize),
			"--temperature",
			String(qwen3Temperature),
			"--top-k",
			String(qwen3TopK),
		];
		if (qwen3Seed.trim()) commonArgs.push("--seed", qwen3Seed);
		if (workerKind === "python") {
			const directArgs = [deps.pythonWorkerPath, ...commonArgs, "--model-name", qwen3ModelName];
			if (deps.pythonCommand === "uv") {
				const args = ["run", "--no-project", "--with", "speech-to-speech==0.2.9", "python", ...directArgs];
				return { command: deps.pythonCommand, args, label: `${deps.pythonCommand} ${args.join(" ")}` };
			}
			return {
				command: deps.pythonCommand,
				args: directArgs,
				label: `${deps.pythonCommand} ${directArgs.join(" ")}`,
			};
		}
		if (workerKind === "cpp") {
			if (!deps.cppWorkerPath) throw new Error("QWEN3_TTS_CPP_WORKER_PATH is required when QWEN3_TTS_WORKER=cpp");
			if (!existsSync(deps.cppWorkerPath)) {
				throw new Error(`C++ Qwen3 TTS worker binary missing: ${deps.cppWorkerPath}.`);
			}
			if (!deps.cppModelPath) throw new Error("QWEN3_TTS_CPP_MODEL_PATH is required when QWEN3_TTS_WORKER=cpp");
			const args = [...commonArgs, "--model-name", deps.cppModelPath];
			return { command: deps.cppWorkerPath, args, label: `${deps.cppWorkerPath} ${args.join(" ")}` };
		}
		if (!deps.rustWorkerPath) throw new Error("QWEN3_TTS_RUST_WORKER_PATH is required when QWEN3_TTS_WORKER=rust");
		if (!existsSync(deps.rustWorkerPath)) {
			throw new Error(`Rust Qwen3 TTS worker binary missing: ${deps.rustWorkerPath}. Run npm run build:tts-rust.`);
		}
		const args = [...commonArgs];
		const rustModelPath = deps.rustModelPath ?? process.env.QWEN3_TTS_MODEL_NAME;
		if (!rustModelPath) throw new Error("QWEN3_TTS_RUST_MODEL_PATH is required when QWEN3_TTS_WORKER=rust");
		args.push("--model-name", rustModelPath);
		return { command: deps.rustWorkerPath, args, label: `${deps.rustWorkerPath} ${args.join(" ")}` };
	}

	async function startWorkerAsync(): Promise<void> {
		if (workerKind === "rust") {
			const rustModelPath = deps.rustModelPath ?? process.env.QWEN3_TTS_MODEL_NAME;
			if (!rustModelPath) throw new Error("QWEN3_TTS_RUST_MODEL_PATH is required when QWEN3_TTS_WORKER=rust");
			const repo = process.env.QWEN3_TTS_RUST_MODEL_REPO ?? defaultRustTtsModelRepo;
			await ensureHuggingFaceModel(rustModelPath, repo, requiredRustTtsModelFiles, "Rust Qwen3 TTS", logger);
		} else if (workerKind === "cpp") {
			if (!deps.cppModelPath) throw new Error("QWEN3_TTS_CPP_MODEL_PATH is required when QWEN3_TTS_WORKER=cpp");
			const repo = process.env.QWEN3_TTS_CPP_MODEL_REPO ?? defaultCppTtsModelRepo;
			await ensureHuggingFaceModel(deps.cppModelPath, repo, requiredCppTtsModelFiles, "C++ Qwen3 TTS", logger);
		}
		const { command, args, label } = workerCommand();
		logger.log(`starting Qwen3 TTS ${workerKind} worker: ${label}`);
		const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
		worker = child;
		// See stt.ts: EPIPE after a worker crash must not crash the server; the exit handler restarts it.
		child.stdin?.on("error", (error) => logger.log(`TTS worker input closed: ${error.message}`));
		child.stdout?.on("data", (chunk: Buffer) => handleStdoutData(chunk));
		child.stderr?.on("data", (chunk: Buffer) => {
			for (const line of chunk.toString("utf8").split(/\r?\n/)) {
				const trimmed = line.trim();
				if (trimmed && shouldLogQwen3Line(trimmed)) qwen3Logger.log(trimmed);
			}
		});
		child.once("error", (error) => {
			rejectReady?.(error);
			for (const userId of turns.keys()) failTurn(userId, error.message);
		});
		child.once("exit", (code, signal) => {
			if (worker === child) worker = undefined;
			const error = new Error(`Qwen3 TTS worker exited code=${code ?? "none"} signal=${signal ?? "none"}`);
			rejectReady?.(error);
			for (const userId of turns.keys()) failTurn(userId, error.message);
			if (code !== 0) logger.log(error.message);
			// Drop in-flight work: a stale activeRequest would block the queue after the restart.
			activeRequest = undefined;
			queue.length = 0;
			stdoutBuffer = Buffer.alloc(0);
			workerVoicePath = qwen3RefAudio;
			voiceRequestIds.clear();
			if (stopping) return;
			const delay = restartDelaysMs[Math.min(restartAttempts, restartDelaysMs.length - 1)] ?? 30000;
			restartAttempts++;
			logger.log(`restarting Qwen3 TTS worker in ${delay / 1000} s`);
			setTimeout(startWorker, delay).unref();
		});
	}

	function startWorker(): void {
		void startWorkerAsync().catch((error) => {
			const normalized = error instanceof Error ? error : new Error(String(error));
			logger.log(normalized.message);
			rejectReady?.(normalized);
			for (const userId of turns.keys()) failTurn(userId, normalized.message);
		});
	}

	function start(userId: string, nextCallbacks: TtsCallbacks, voicePath = qwen3RefAudio): void {
		cancelUser(userId, "new TTS stream");
		turns.set(userId, {
			callbacks: nextCallbacks,
			voicePath,
			pendingRequests: 0,
			turnEnded: false,
			streamStarted: false,
			cancelled: false,
		});
	}

	function pushText(userId: string, text: string): void {
		const turn = turns.get(userId);
		const trimmed = text.trim();
		if (!turn || !trimmed) return;
		const request = { id: nextRequestId++, userId, text: trimmed, voicePath: turn.voicePath };
		turn.pendingRequests++;
		queue.push(request);
		pump();
	}

	function end(userId: string): void {
		const turn = turns.get(userId);
		if (!turn) return;
		turn.turnEnded = true;
		if (!turn.streamStarted && !userHasQueuedRequest(userId)) turn.callbacks.onStart(qwen3OutputSampleRate);
		finishTurnIfIdle(userId);
	}

	function cancelUser(userId: string, reason: string): void {
		qwen3Logger.log(`cancel ${userId}: ${reason}`);
		const turn = turns.get(userId);
		if (turn) turn.cancelled = true;
		let removed = 0;
		for (let i = queue.length - 1; i >= 0; i--) {
			const request = queue[i];
			if (request?.userId !== userId) continue;
			queue.splice(i, 1);
			removed++;
		}
		if (turn) turn.pendingRequests = Math.max(0, turn.pendingRequests - removed);
		if (activeRequest?.userId === userId) activeRequest.cancelled = true;
		turns.delete(userId);
	}

	function cancel(reason: string): void {
		qwen3Logger.log(`cancel all: ${reason}`);
		for (const userId of [...turns.keys()]) cancelUser(userId, reason);
		queue.length = 0;
	}

	function stop(): void {
		stopping = true;
		try {
			sendFrame(workerInputShutdown, 0);
		} catch {
			// process may already be gone
		}
		worker?.kill();
	}

	startWorker();

	return { ready, start, pushText, end, cancelUser, cancel, stop, defaultVoicePath: qwen3RefAudio };
}

function createDisabledTtsService(logger: Logger): TtsService {
	logger.tag("tts").log("TTS disabled; set QWEN3_TTS_WORKER=cpp, rust, or python to enable it");
	const turns = new Map<string, TtsCallbacks>();
	return {
		ready: Promise.resolve(),
		defaultVoicePath: "",
		start: (userId, callbacks) => {
			turns.set(userId, callbacks);
		},
		pushText: () => undefined,
		end: (userId) => {
			const callbacks = turns.get(userId);
			if (!callbacks) return;
			turns.delete(userId);
			callbacks.onDone();
		},
		cancelUser: (userId) => {
			turns.delete(userId);
		},
		cancel: () => {
			turns.clear();
		},
		stop: () => undefined,
	};
}
