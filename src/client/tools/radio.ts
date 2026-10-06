import type { RadioRpcRequest, RadioRpcResponse, RadioStation, SpotifyNowPlaying } from "../../types.js";
import type { ClientLogger } from "../logger.js";

// Plays internet radio on this device with a plain <audio> element. Not routed through Web Audio:
// most stations send no CORS headers, which would make a MediaElementSource output silence.

const volumeKey = "radio_volume";
const volumeStep = 0.15;
// While the robot thinks or speaks, music drops to this share of its volume.
const duckFactor = 0.15;
const startTimeoutMs = 15000;
// Zero-length WAV, played once inside a tap so iOS allows later programmatic playback.
const silentWav = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";

export interface RadioTool {
	unlock: () => void;
	setDucked: (ducked: boolean) => void;
	isPlaying: () => boolean;
	stop: () => void;
	handle: (payload: RadioRpcRequest, signal: AbortSignal) => Promise<RadioRpcResponse>;
}

function clampVolume(value: number): number {
	return Number.isFinite(value) ? Math.max(0.05, Math.min(1, value)) : 0.6;
}

export function createRadioTool(deps: {
	logger: ClientLogger;
	onNowPlaying: (playback: SpotifyNowPlaying | undefined) => void;
	onPlayingChange: (playing: boolean) => void;
}): RadioTool {
	const logger = deps.logger.tag("radio");
	const audio = new Audio();
	audio.preload = "none";
	let station: RadioStation | undefined;
	let ducked = false;
	let volume = 0.6;
	try {
		volume = clampVolume(Number(localStorage.getItem(volumeKey) ?? "0.6"));
	} catch {
		// storage unavailable: keep the default
	}

	const isPlaying = () => Boolean(station) && !audio.paused;
	const applyVolume = () => {
		audio.volume = ducked ? volume * duckFactor : volume;
	};
	const report = (): RadioRpcResponse => ({ ok: true, playing: isPlaying(), station, volume });
	for (const event of ["playing", "pause", "ended", "error"]) {
		audio.addEventListener(event, () => {
			if (event === "error" && station)
				logger.log(`stream error on ${station.name}: ${audio.error?.message ?? "unknown"}`);
			deps.onPlayingChange(isPlaying());
		});
	}

	function stop(): void {
		audio.pause();
		audio.removeAttribute("src");
		audio.load();
		station = undefined;
		deps.onNowPlaying(undefined);
		deps.onPlayingChange(false);
	}

	async function start(url: string, signal: AbortSignal): Promise<void> {
		audio.src = url;
		applyVolume();
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				audio.play(),
				new Promise((_, reject) => {
					timer = setTimeout(
						() => reject(new Error("the station did not start within 15 seconds")),
						startTimeoutMs,
					);
					signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
				}),
			]);
		} finally {
			clearTimeout(timer);
		}
	}

	async function handle(payload: RadioRpcRequest, signal: AbortSignal): Promise<RadioRpcResponse> {
		try {
			if (payload.action === "play") {
				station = payload.station;
				await start(payload.url, signal);
				const details = [station.country, station.tags?.split(",").slice(0, 3).join(", ")]
					.filter(Boolean)
					.join(" - ");
				deps.onNowPlaying({
					title: `Radio: ${station.name}`,
					subtitle: details,
					coverUrl: station.favicon,
					isPlaying: true,
				});
				logger.log(`playing ${station.name} (${station.codec ?? "?"} ${station.bitrate ?? "?"} kbps)`);
			} else if (payload.action === "stop") {
				stop();
			} else if (payload.action === "pause") {
				audio.pause();
			} else if (payload.action === "resume") {
				if (!station) throw new Error("Nothing to resume; the radio is off.");
				// Live streams: reload so playback resumes at the live edge, not from a stale buffer.
				await start(audio.src, signal);
			} else if (payload.action === "louder" || payload.action === "quieter") {
				volume = clampVolume(volume + (payload.action === "louder" ? volumeStep : -volumeStep));
				applyVolume();
				try {
					localStorage.setItem(volumeKey, String(volume));
				} catch {
					// storage unavailable: volume still applies for this page
				}
			}
			return report();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (payload.action === "play" || payload.action === "resume") stop();
			logger.log(`${payload.action} failed: ${message}`);
			return { ok: false, error: `Radio ${payload.action} failed: ${message}` };
		}
	}

	return {
		unlock: () => {
			if (station) return;
			audio.src = silentWav;
			void audio
				.play()
				.then(() => audio.pause())
				.catch(() => undefined);
		},
		setDucked: (next) => {
			if (ducked === next) return;
			ducked = next;
			applyVolume();
		},
		isPlaying,
		stop,
		handle,
	};
}
