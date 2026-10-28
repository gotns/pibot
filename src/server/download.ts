import { createWriteStream } from "node:fs";
import { mkdir, rename, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import type { Logger } from "./logger.js";

const maxAttempts = 4;
const progressIntervalMs = 5000;

function mib(bytes: number): string {
	return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

// Downloads to <path>.part and, after a dropped connection or a restart, resumes it with an HTTP Range
// request instead of starting over (model files are up to 1.3 GB). pipeline() turns stream failures into
// a rejection, so a dropped connection can no longer crash the server with an unhandled 'error' event.
export async function downloadFile(url: string, path: string, label: string, logger: Logger): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const partPath = `${path}.part`;
	for (let attempt = 1; ; attempt++) {
		const have = await stat(partPath).then(
			(info) => info.size,
			() => 0,
		);
		try {
			const response = await fetch(url, { headers: have > 0 ? { Range: `bytes=${have}-` } : {} });
			// 416: the part file already holds the whole file (a previous run died just before the rename).
			if (response.status === 416 && have > 0) break;
			if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
			const resumed = response.status === 206;
			const remaining = Number(response.headers.get("content-length") ?? "0");
			const total = remaining > 0 ? remaining + (resumed ? have : 0) : 0;
			logger.log(`downloading ${label}${resumed ? ` (resuming at ${mib(have)})` : ""}`);
			let received = resumed ? have : 0;
			let lastLog = Date.now();
			const body = Readable.fromWeb(response.body as WebReadableStream);
			body.on("data", (chunk: Buffer) => {
				received += chunk.byteLength;
				if (Date.now() - lastLog < progressIntervalMs) return;
				lastLog = Date.now();
				logger.log(`downloading ${label}: ${mib(received)}${total > 0 ? ` / ${mib(total)}` : ""}`);
			});
			await pipeline(body, createWriteStream(partPath, { flags: resumed ? "a" : "w" }));
			break;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (attempt >= maxAttempts) throw new Error(`failed to download ${label}: ${message}`);
			logger.log(`download of ${label} interrupted (${message}); retrying in ${attempt * 2} s`);
			await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
		}
	}
	await rename(partPath, path);
	logger.log(`downloaded ${label}`);
}
