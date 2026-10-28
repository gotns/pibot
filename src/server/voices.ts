import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Voices the robot can speak with. The TTS worker clones a voice from a short reference recording, so a
// voice is just a WAV file: built-in ones ship with pibot, library ones are shared by every account, and
// custom ones are an account's own recordings.

export interface VoiceInfo {
	id: string;
	name: string;
	description?: string;
	kind: "builtin" | "library" | "custom";
}

const builtinVoices: Array<VoiceInfo & { file: string }> = [
	{
		id: "builtin:pibot",
		name: "Pipi",
		description: "The original pibot voice",
		kind: "builtin",
		file: "data/voices/elevenlabs-pibot-reference.wav",
	},
];
const libraryDir = "data/voices/library";
const idPattern = /^[a-z0-9-]{1,64}$/;
const minSeconds = 3;
const maxSeconds = 60;

export interface VoiceLibrary {
	defaultId: string;
	list: (user: string) => Promise<VoiceInfo[]>;
	pathFor: (user: string, id: string) => Promise<string | undefined>;
	addCustom: (user: string, name: string, wav: Buffer) => Promise<VoiceInfo>;
	removeCustom: (user: string, id: string) => Promise<boolean>;
}

// Checks the upload is a PCM or float WAV the worker can read, and returns its length in seconds.
function wavSeconds(wav: Buffer): number {
	if (wav.length < 44 || wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") {
		throw new Error("The recording must be a WAV file.");
	}
	let offset = 12;
	let byteRate = 0;
	let dataBytes = 0;
	while (offset + 8 <= wav.length) {
		const id = wav.toString("ascii", offset, offset + 4);
		const size = wav.readUInt32LE(offset + 4);
		if (id === "fmt ") {
			const format = wav.readUInt16LE(offset + 8);
			const channels = wav.readUInt16LE(offset + 10);
			const sampleRate = wav.readUInt32LE(offset + 12);
			byteRate = wav.readUInt32LE(offset + 16);
			if (format !== 1 && format !== 3) throw new Error("The WAV must be PCM or float audio.");
			if (channels < 1 || channels > 2 || sampleRate < 8000 || sampleRate > 48000) {
				throw new Error("The WAV must be mono or stereo, 8 to 48 kHz.");
			}
		}
		if (id === "data") dataBytes = Math.min(size, wav.length - offset - 8);
		offset += 8 + size + (size % 2);
	}
	if (!byteRate || !dataBytes) throw new Error("The WAV file has no audio.");
	return dataBytes / byteRate;
}

async function readMeta(path: string): Promise<{ name?: string; description?: string }> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as { name?: string; description?: string };
	} catch {
		return {};
	}
}

async function wavIds(dir: string): Promise<string[]> {
	try {
		return (await readdir(dir))
			.filter((file) => file.endsWith(".wav"))
			.map((file) => file.slice(0, -4))
			.filter((id) => idPattern.test(id))
			.sort();
	} catch {
		return [];
	}
}

export function createVoiceLibrary(deps: { userDir: (user: string) => string }): VoiceLibrary {
	const customDir = (user: string) => join(deps.userDir(user), "voices");

	async function list(user: string): Promise<VoiceInfo[]> {
		const voices: VoiceInfo[] = builtinVoices.map(({ file: _file, ...voice }) => voice);
		for (const id of await wavIds(libraryDir)) {
			const meta = await readMeta(join(libraryDir, `${id}.json`));
			voices.push({ id: `library:${id}`, name: meta.name ?? id, description: meta.description, kind: "library" });
		}
		for (const id of await wavIds(customDir(user))) {
			const meta = await readMeta(join(customDir(user), `${id}.json`));
			voices.push({ id: `custom:${id}`, name: meta.name ?? id, description: "Your recording", kind: "custom" });
		}
		return voices;
	}

	async function pathFor(user: string, id: string): Promise<string | undefined> {
		const builtin = builtinVoices.find((voice) => voice.id === id);
		if (builtin) return builtin.file;
		const [kind, name] = id.split(":");
		if (!name || !idPattern.test(name)) return undefined;
		const path =
			kind === "library"
				? join(libraryDir, `${name}.wav`)
				: kind === "custom"
					? join(customDir(user), `${name}.wav`)
					: "";
		if (!path) return undefined;
		return (await stat(path).then(
			(info) => info.isFile(),
			() => false,
		))
			? path
			: undefined;
	}

	return {
		defaultId: "builtin:pibot",
		list,
		pathFor,
		addCustom: async (user, name, wav) => {
			const seconds = wavSeconds(wav);
			if (seconds < minSeconds || seconds > maxSeconds) {
				throw new Error(
					`The recording must be ${minSeconds} to ${maxSeconds} seconds long (got ${seconds.toFixed(1)} s).`,
				);
			}
			const label = name.trim().slice(0, 40) || "My voice";
			const slug =
				label
					.toLowerCase()
					.replace(/[^a-z0-9]+/g, "-")
					.replace(/^-|-$/g, "")
					.slice(0, 40) || "voice";
			const id = `${slug}-${randomBytes(3).toString("hex")}`;
			const dir = customDir(user);
			await mkdir(dir, { recursive: true });
			await writeFile(join(dir, `${id}.wav`), wav);
			await writeFile(join(dir, `${id}.json`), `${JSON.stringify({ name: label }, null, "\t")}\n`);
			return { id: `custom:${id}`, name: label, description: "Your recording", kind: "custom" };
		},
		removeCustom: async (user, id) => {
			const [kind, name] = id.split(":");
			if (kind !== "custom" || !name || !idPattern.test(name)) return false;
			const path = join(customDir(user), `${name}.wav`);
			if (
				!(await stat(path).then(
					() => true,
					() => false,
				))
			)
				return false;
			await rm(path, { force: true });
			await rm(join(customDir(user), `${name}.json`), { force: true });
			return true;
		},
	};
}
