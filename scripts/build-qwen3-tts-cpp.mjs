#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { resolve } from "node:path";

function run(command, args) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: "inherit", shell: process.platform === "win32" });
		child.once("error", reject);
		child.once("exit", (code, signal) => {
			if (code === 0) {
				resolve();
				return;
			}
			reject(new Error(`${command} ${args.join(" ")} exited code=${code ?? "none"} signal=${signal ?? "none"}`));
		});
	});
}

const ggmlArgs = [
	"-S",
	"native/qwen3-tts.cpp/ggml",
	"-B",
	"native/qwen3-tts.cpp/ggml/build",
	"-DCMAKE_BUILD_TYPE=Release",
	"-DGGML_BUILD_TESTS=OFF",
	"-DGGML_BUILD_EXAMPLES=OFF",
	"-DBUILD_SHARED_LIBS=OFF",
	"-DGGML_STATIC=ON",
];
if (process.platform === "darwin") {
	ggmlArgs.push("-DGGML_METAL=ON");
} else {
	ggmlArgs.push("-DGGML_VULKAN=ON");
}

await run("npm", ["run", "submodules", "--", "native/qwen3-tts.cpp"]);

// pibot's own changes to the worker (per-request voices) are kept as a patch here, because the submodule
// points at an upstream repository. Applied once; skipped when the tree already contains it.
const voicesPatch = resolve("native/patches/qwen3-tts-voices.patch");
const alreadyApplied =
	spawnSync("git", ["-C", "native/qwen3-tts.cpp", "apply", "--reverse", "--check", voicesPatch]).status === 0;
if (!alreadyApplied) await run("git", ["-C", "native/qwen3-tts.cpp", "apply", voicesPatch]);
await run("cmake", ggmlArgs);
await run("cmake", ["--build", "native/qwen3-tts.cpp/ggml/build", "-j"]);
await run("cmake", ["-S", "native/qwen3-tts.cpp", "-B", "native/qwen3-tts.cpp/build", "-DQWEN3_TTS_COREML=OFF"]);
await run("cmake", ["--build", "native/qwen3-tts.cpp/build", "--target", "qwen3-tts-worker", "qwen3-tts-cli", "-j"]);
