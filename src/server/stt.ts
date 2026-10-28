import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { downloadFile } from "./download.js";
import type { Logger } from "./logger.js";

export interface SttServiceDeps {
	parakeetCppWorkerPath: string;
	parakeetCppModelPath: string;
	sileroVadGgmlModelPath: string;
	logger: Logger;
	onEvent: (event: SttEvent) => void;
}

export interface SttService {
	handleAudioFrame: (userId: string, data: Buffer) => void;
	closeUser: (userId: string) => void;
	flushUser: (userId: string) => void;
	stopChildProcess: () => void;
}

export type SttEvent =
	| {
			type: "ready";
			sampleRate: number;
			vadChunkMs: number;
			vadThreshold: number;
			minSilenceMs: number;
			prerollMs: number;
			interimIntervalMs?: number;
			interimMinAudioMs?: number;
			interimWindowMs?: number;
			energyGate?: number;
	  }
	| { type: "speech_start"; userId: string; index: number }
	| { type: "speech_end"; userId: string; index: number; duration: number }
	| { type: "speech_drop"; userId: string; index: number; duration: number; reason: string }
	| {
			type: "interim";
			userId: string;
			index: number;
			text: string;
			audioMs: number;
			windowMs?: number;
			decodeMs: number;
	  }
	| { type: "final"; userId: string; index: number; text: string; decodeMs: number }
	| { type: "error"; userId?: string; message: string };

const PARAKEET_CPP_REPO = "https://huggingface.co/mudler/parakeet-cpp-gguf/resolve/main";
const WHISPER_VAD_REPO = "https://huggingface.co/ggml-org/whisper-vad/resolve/main";
const sttInputAudioFrame = 1;
const sttInputCloseUser = 2;
const sttInputFlushUser = 3;

type SttWorkerMsg =
	| {
			type: "ready";
			sampleRate: number;
			vadChunkMs: number;
			vadThreshold: number;
			minSilenceMs: number;
			speechPadMs: number;
			prerollMs: number;
			interimIntervalMs?: number;
			interimMinAudioMs?: number;
			interimWindowMs?: number;
			energyGate?: number;
	  }
	| { type: "speech_start"; userId: string; index: number; time: number }
	| { type: "speech_end"; userId: string; index: number; duration: number }
	| { type: "speech_drop"; userId: string; index: number; duration: number; reason: string }
	| {
			type: "interim";
			userId: string;
			index: number;
			text: string;
			audioMs: number;
			windowMs?: number;
			decodeMs: number;
	  }
	| { type: "final"; userId: string; index: number; text: string; duration: number; decodeMs: number }
	| { type: "error"; userId?: string; message: string };

function streamLines(stream: NodeJS.ReadableStream | null | undefined, onLine: (line: string) => void): void {
	if (!stream) return;
	let buffered = "";
	stream.on("data", (chunk: Buffer | string) => {
		buffered += chunk.toString();
		while (true) {
			const newline = buffered.indexOf("\n");
			if (newline < 0) return;
			const line = buffered.slice(0, newline).trim();
			buffered = buffered.slice(newline + 1);
			if (line) onLine(line);
		}
	});
	stream.on("end", () => {
		const line = buffered.trim();
		buffered = "";
		if (line) onLine(line);
	});
}

export function createSttService(deps: SttServiceDeps): SttService {
	let childProcess: ChildProcess | undefined;
	let stdout = "";
	let stopping = false;
	let restartAttempts = 0;
	const restartDelaysMs = [1000, 2000, 5000, 10000, 30000];
	const logger = deps.logger.tag("stt");
	const emit = deps.onEvent;

	function startWorker(): void {
		void startWorkerAsync().catch((error) => {
			emit({ type: "error", message: error instanceof Error ? error.message : String(error) });
		});
	}

	async function startWorkerAsync(): Promise<void> {
		if (childProcess && !childProcess.killed) return;
		stdout = "";
		const command = workerCommand();
		await ensureModelFiles();
		logger.log("loading parakeet.cpp STT worker");
		const child = spawn(command.file, command.args, {
			env: {
				...process.env,
				PARAKEET_CPP_MODEL_PATH: deps.parakeetCppModelPath,
				SILERO_VAD_GGML_MODEL_PATH: deps.sileroVadGgmlModelPath,
			},
			stdio: ["pipe", "pipe", "pipe"],
		});
		childProcess = child;
		// Writing to a worker that just died fails with EPIPE; unhandled, that 'error' event would crash the
		// whole server. The exit handler restarts the worker.
		child.stdin?.on("error", (error) => logger.log(`STT worker input closed: ${error.message}`));
		child.stdout?.on("data", (data: Buffer) => handleStdout(data));
		streamLines(child.stderr, (line) => logger.log(line));
		child.once("error", (error) => emit({ type: "error", message: error.message }));
		child.once("exit", (code, signal) => {
			if (childProcess === child) childProcess = undefined;
			logger.log(`parakeet.cpp STT worker exited code=${code ?? "none"} signal=${signal ?? "none"}`);
			if (stopping) return;
			// Without a restart the server stays up but deaf; tell connected clients and bring it back.
			const delay = restartDelaysMs[Math.min(restartAttempts, restartDelaysMs.length - 1)] ?? 30000;
			restartAttempts++;
			emit({ type: "error", message: `Speech recognition stopped; restarting in ${delay / 1000} s` });
			setTimeout(startWorker, delay).unref();
		});
	}

	function workerCommand(): { file: string; args: string[] } {
		if (!existsSync(deps.parakeetCppWorkerPath)) {
			throw new Error(
				`parakeet.cpp STT worker missing: ${deps.parakeetCppWorkerPath}. Run npm run build:stt-parakeet-cpp.`,
			);
		}
		return { file: deps.parakeetCppWorkerPath, args: [deps.parakeetCppModelPath, deps.sileroVadGgmlModelPath] };
	}

	async function ensureModelFiles(): Promise<void> {
		if (!(await hasUsableFile(deps.parakeetCppModelPath))) {
			await mkdir(dirname(deps.parakeetCppModelPath), { recursive: true });
			const file = basename(deps.parakeetCppModelPath);
			await downloadFile(
				`${PARAKEET_CPP_REPO}/${file}`,
				deps.parakeetCppModelPath,
				`STT model file ${file}`,
				logger,
			);
		}
		if (!(await hasUsableFile(deps.sileroVadGgmlModelPath))) {
			await mkdir(dirname(deps.sileroVadGgmlModelPath), { recursive: true });
			const file = basename(deps.sileroVadGgmlModelPath);
			await downloadFile(
				`${WHISPER_VAD_REPO}/${file}`,
				deps.sileroVadGgmlModelPath,
				`VAD model file ${file}`,
				logger,
			);
		}
	}

	async function hasUsableFile(path: string): Promise<boolean> {
		try {
			return (await stat(path)).size > 0;
		} catch {
			return false;
		}
	}

	function handleStdout(data: Buffer): void {
		stdout += data.toString("utf8");
		while (true) {
			const newline = stdout.indexOf("\n");
			if (newline < 0) return;
			const line = stdout.slice(0, newline).trim();
			stdout = stdout.slice(newline + 1);
			if (!line) continue;
			try {
				handleMessage(JSON.parse(line) as SttWorkerMsg);
			} catch (error) {
				logger.log(
					`failed to parse worker line: ${line}; ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
	}

	function handleMessage(message: SttWorkerMsg): void {
		if (message.type === "ready") {
			restartAttempts = 0;
			emit({
				type: "ready",
				sampleRate: message.sampleRate,
				vadChunkMs: message.vadChunkMs,
				vadThreshold: message.vadThreshold,
				minSilenceMs: message.minSilenceMs,
				prerollMs: message.prerollMs,
				interimIntervalMs: message.interimIntervalMs,
				interimMinAudioMs: message.interimMinAudioMs,
				interimWindowMs: message.interimWindowMs,
				energyGate: message.energyGate,
			});
			return;
		}
		if (message.type === "speech_start") {
			emit({ type: "speech_start", userId: message.userId, index: message.index });
			return;
		}
		if (message.type === "speech_end") {
			emit({ type: "speech_end", userId: message.userId, index: message.index, duration: message.duration });
			return;
		}
		if (message.type === "speech_drop") {
			emit({
				type: "speech_drop",
				userId: message.userId,
				index: message.index,
				duration: message.duration,
				reason: message.reason,
			});
			return;
		}
		if (message.type === "interim") {
			emit({
				type: "interim",
				userId: message.userId,
				index: message.index,
				text: message.text.trim(),
				audioMs: message.audioMs,
				windowMs: message.windowMs,
				decodeMs: message.decodeMs,
			});
			return;
		}
		if (message.type === "final") {
			emit({
				type: "final",
				userId: message.userId,
				index: message.index,
				text: message.text.trim(),
				decodeMs: message.decodeMs,
			});
			return;
		}
		emit({ type: "error", userId: message.userId, message: message.message });
	}

	function writeInputFrame(type: number, userId: string, payload: Buffer = Buffer.alloc(0)): void {
		if (!childProcess?.stdin || childProcess.stdin.destroyed) return;
		const userIdBytes = Buffer.from(userId, "utf8");
		const header = Buffer.allocUnsafe(1 + 4 + userIdBytes.byteLength + 4);
		header.writeUInt8(type, 0);
		header.writeUInt32LE(userIdBytes.byteLength, 1);
		userIdBytes.copy(header, 5);
		header.writeUInt32LE(payload.byteLength, 5 + userIdBytes.byteLength);
		childProcess.stdin.write(header);
		if (payload.byteLength > 0) childProcess.stdin.write(payload);
	}

	function handleAudioFrame(userId: string, data: Buffer): void {
		// The worker reads 16-bit samples; an odd byte count can only be a malformed frame.
		if (data.byteLength % 2 !== 0) return;
		writeInputFrame(sttInputAudioFrame, userId, data);
	}

	function closeUser(userId: string): void {
		writeInputFrame(sttInputCloseUser, userId);
	}

	// Ends the user's current utterance immediately (push-to-talk release, mic gate closing).
	function flushUser(userId: string): void {
		writeInputFrame(sttInputFlushUser, userId);
	}

	function stopChildProcess(): void {
		stopping = true;
		childProcess?.kill();
	}

	workerCommand();
	startWorker();
	return { handleAudioFrame, closeUser, flushUser, stopChildProcess };
}
