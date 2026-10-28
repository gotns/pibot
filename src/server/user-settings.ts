import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { maxSpeechRate, minSpeechRate } from "./speech-tempo.js";

// Per-account preferences, set from the settings sheet and applied by the server on the next turn.
export interface UserSettings {
	voice: string;
	voiceEffect: boolean;
	speechRate: number;
	wakeNameOnly: boolean;
	brain: "fast" | "smart";
}

export const defaultSettings: UserSettings = {
	voice: "builtin:pibot",
	voiceEffect: true,
	speechRate: 1,
	wakeNameOnly: false,
	brain: "fast",
};

export interface SettingsStore {
	get: (user: string) => Promise<UserSettings>;
	update: (user: string, changes: unknown) => Promise<UserSettings>;
}

// Accepts only known keys with the right types; anything else in the request is ignored.
function merge(current: UserSettings, changes: unknown): UserSettings {
	if (!changes || typeof changes !== "object") return current;
	const input = changes as Record<string, unknown>;
	const next = { ...current };
	if (typeof input.voice === "string" && input.voice.length <= 120) next.voice = input.voice;
	if (typeof input.voiceEffect === "boolean") next.voiceEffect = input.voiceEffect;
	if (typeof input.wakeNameOnly === "boolean") next.wakeNameOnly = input.wakeNameOnly;
	if (typeof input.speechRate === "number" && Number.isFinite(input.speechRate)) {
		next.speechRate = Math.round(Math.max(minSpeechRate, Math.min(maxSpeechRate, input.speechRate)) * 100) / 100;
	}
	if (input.brain === "fast" || input.brain === "smart") next.brain = input.brain;
	return next;
}

export function createSettingsStore(fileForUser: (user: string) => string): SettingsStore {
	const cache = new Map<string, UserSettings>();
	async function get(user: string): Promise<UserSettings> {
		const cached = cache.get(user);
		if (cached) return cached;
		let settings = defaultSettings;
		try {
			settings = merge(defaultSettings, JSON.parse(await readFile(fileForUser(user), "utf8")));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		cache.set(user, settings);
		return settings;
	}
	return {
		get,
		update: async (user, changes) => {
			const next = merge(await get(user), changes);
			const file = fileForUser(user);
			await mkdir(dirname(file), { recursive: true });
			await writeFile(`${file}.tmp`, `${JSON.stringify(next, null, "\t")}\n`);
			await rename(`${file}.tmp`, file);
			cache.set(user, next);
			return next;
		},
	};
}
