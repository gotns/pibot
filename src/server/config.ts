import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { localLlmConfigs, parseLocalLlmId } from "./llama.js";

const serverDir = fileURLToPath(new URL(".", import.meta.url));
const localLlm = parseLocalLlmId(process.env.LOCAL_LLM);

export const serverConfig = {
	publicDir: resolve(serverDir, "../../public"),
	pibotCacheDir: process.env.PIBOT_CACHE_DIR ?? resolve(homedir(), ".cache/pibot"),
	port: Number(process.env.PORT ?? 8010),
	host: process.env.HOST ?? "0.0.0.0",
	parakeetCppWorkerPath:
		process.env.PARAKEET_CPP_WORKER_PATH ??
		resolve(
			serverDir,
			`../../native/parakeet-cpp-stt/build/parakeet-cpp-stt-worker${process.platform === "win32" ? ".exe" : ""}`,
		),
	parakeetCppModelPath:
		process.env.PARAKEET_CPP_MODEL_PATH ??
		resolve(homedir(), "models/parakeet-cpp-gguf", process.env.PARAKEET_CPP_MODEL_FILE ?? "tdt-0.6b-v3-q8_0.gguf"),
	sileroVadGgmlModelPath:
		process.env.SILERO_VAD_GGML_MODEL_PATH ??
		resolve(homedir(), "models/whisper-vad", process.env.SILERO_VAD_GGML_MODEL_FILE ?? "ggml-silero-v6.2.0.bin"),
	llamaBaseUrl: process.env.LLAMA_BASE_URL ?? "http://127.0.0.1:8080/v1",
	llamaHost: process.env.LLAMA_HOST ?? "127.0.0.1",
	llamaPort: Number(process.env.LLAMA_PORT ?? 8080),
	llamaModelAlias: process.env.LLAMA_MODEL_ALIAS,
	localLlm,
	llamaContextWindow: Number(process.env.LLAMA_CONTEXT_WINDOW ?? localLlmConfigs[localLlm].contextWindow),
	llamaModelDir:
		process.env.LLAMA_MODEL_DIR ?? resolve(homedir(), "models", localLlmConfigs[localLlm].defaultModelDirName),
	qwen3TtsWorker: process.env.QWEN3_TTS_WORKER ?? "cpp",
	qwen3TtsPythonCommand: process.env.QWEN3_TTS_PYTHON_COMMAND ?? "uv",
	qwen3TtsPythonWorkerPath:
		process.env.QWEN3_TTS_PYTHON_WORKER_PATH ?? resolve(serverDir, "../../scripts/qwen3-tts-worker.py"),
	qwen3TtsRustWorkerPath:
		process.env.QWEN3_TTS_RUST_WORKER_PATH ??
		resolve(
			serverDir,
			`../../native/qwen3_tts_rs/target/release/pibot-tts-worker${process.platform === "win32" ? ".exe" : ""}`,
		),
	qwen3TtsRustModelPath:
		process.env.QWEN3_TTS_RUST_MODEL_PATH ?? resolve(homedir(), "models/qwen3-tts-12hz-0.6b-base-6bit"),
	qwen3TtsCppWorkerPath:
		process.env.QWEN3_TTS_CPP_WORKER_PATH ?? resolve(serverDir, "../../native/qwen3-tts.cpp/build/qwen3-tts-worker"),
	qwen3TtsCppModelPath: process.env.QWEN3_TTS_CPP_MODEL_PATH ?? resolve(homedir(), "models/qwen3-tts-0.6b-q8_0-gguf"),
	version: String(Date.now()),
	maxContextImages: Number(process.env.MAX_CONTEXT_IMAGES ?? 4),
	memoryFile: process.env.MEMORY_FILE ?? "data/memories.json",
	usersFile: process.env.USERS_FILE ?? "data/users.json",
	sessionsFile: process.env.SESSIONS_FILE ?? "data/sessions.json",
	trafficFile: process.env.TRAFFIC_FILE ?? "data/traffic.json",
	spotifyClientId: process.env.SPOTIFY_CLIENT_ID,
	userMemoryDir: process.env.USER_MEMORY_DIR ?? "data/user-memories",
	adminUser: process.env.ADMIN_USER ?? "admin",
	adminPassword: process.env.ADMIN_PASSWORD ?? "admin",
	secureCookies: process.env.SECURE_COOKIES === "1",
};
