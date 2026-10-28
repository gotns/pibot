import { createCaptureNode } from "../audio-capture.js";
import { decodeAudioFile, encodeWav, resampleMono } from "../wav.js";

export interface PanelSettings {
	voice: string;
	voiceEffect: boolean;
	speechRate: number;
	wakeNameOnly: boolean;
	brain: "fast" | "smart";
}

export interface SettingsPanelData {
	robotName: string;
	settings: PanelSettings;
	brains: { fast: string; smart?: string };
	radioVolume: number;
	showLog: boolean;
	robotConnected: boolean;
}

interface VoiceInfo {
	id: string;
	name: string;
	description?: string;
	kind: "builtin" | "library" | "custom";
}

const readingText =
	"Hello! I am recording my voice so my robot can speak like me. The quick brown fox jumps over the lazy dog, " +
	"and on sunny days I like to take long walks, drink a cup of tea, and listen to some good music.";
const minRecordSeconds = 8;
const maxRecordSeconds = 30;

type Child = Node | string | false | undefined;

function el<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	props: Partial<HTMLElementTagNameMap[K]> & { className?: string } = {},
	children: Child[] = [],
): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	Object.assign(node, props);
	for (const child of children) if (child) node.append(child);
	return node;
}

async function api<T>(method: string, path: string, body?: unknown, contentType = "application/json"): Promise<T> {
	const response = await fetch(path, {
		method,
		headers: body === undefined ? undefined : { "content-type": contentType },
		body: body === undefined ? undefined : body instanceof Blob ? body : JSON.stringify(body),
	});
	const data = (await response.json().catch(() => ({}))) as { error?: string } & T;
	if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
	return data;
}

// The settings sheet. Every change is saved as it is made; the page listens for the events it sends.
export class SettingsPanelElement extends HTMLElement {
	private data: SettingsPanelData | undefined;
	private voices: VoiceInfo[] = [];
	private recording: { stop: () => Promise<Float32Array> } | undefined;
	private pendingVoice: Blob | undefined;

	async open(data: SettingsPanelData): Promise<void> {
		this.data = data;
		this.hidden = false;
		this.render();
		try {
			this.voices = (await api<{ voices: VoiceInfo[] }>("GET", "/api/voices")).voices;
		} catch (error) {
			this.voices = [];
			this.notice(`Could not load voices: ${error instanceof Error ? error.message : String(error)}`);
		}
		this.render();
		this.scrollIntoView({ behavior: "smooth", block: "start" });
	}

	private emit(name: string, detail?: unknown): void {
		this.dispatchEvent(new CustomEvent(name, { detail }));
	}

	private async save(changes: Partial<PanelSettings>): Promise<void> {
		if (!this.data) return;
		try {
			const { settings } = await api<{ settings: PanelSettings }>("POST", "/api/settings", changes);
			this.data.settings = settings;
			this.emit("settings-changed", settings);
		} catch (error) {
			this.notice(`Could not save: ${error instanceof Error ? error.message : String(error)}`);
		}
		this.render();
	}

	private notice(text: string): void {
		const line = this.querySelector(".settings-notice");
		if (line) line.textContent = text;
	}

	private render(): void {
		const data = this.data;
		if (!data) return;
		this.className = "panel settings-panel";
		const close = el("button", { className: "close", textContent: "Close", type: "button" });
		close.addEventListener("click", () => {
			this.hidden = true;
		});
		this.replaceChildren(
			el("div", { className: "panel-head" }, [el("h2", { textContent: "Settings" }), close]),
			el("p", { className: "settings-notice", role: "status" }),
			this.voiceSection(data),
			this.speakingSection(data),
			this.listeningSection(data),
			this.brainSection(data),
			this.musicSection(data),
			this.robotSection(data),
			this.accountSection(),
			this.developerSection(data),
		);
	}

	private section(title: string, children: Child[]): HTMLElement {
		return el("section", { className: "settings-section" }, [el("h3", { textContent: title }), ...children]);
	}

	private voiceSection(data: SettingsPanelData): HTMLElement {
		const list = el("div", { className: "voice-list", role: "radiogroup" });
		for (const voice of this.voices) {
			const radio = el("input", {
				type: "radio",
				name: "voice",
				value: voice.id,
				checked: voice.id === data.settings.voice,
			});
			radio.addEventListener("change", () => void this.save({ voice: voice.id }));
			const preview = el("button", { type: "button", className: "small", textContent: "Play sample" });
			preview.addEventListener("click", () => this.emit("preview-voice", voice.id));
			const actions: Child[] = [preview];
			if (voice.kind === "custom") {
				const remove = el("button", { type: "button", className: "small quiet", textContent: "Delete" });
				remove.addEventListener("click", () => void this.removeVoice(voice));
				actions.push(remove);
			}
			list.append(
				el("div", { className: `voice-row${voice.id === data.settings.voice ? " selected" : ""}` }, [
					el("label", { className: "voice-choice" }, [
						radio,
						el("span", {}, [
							el("strong", { textContent: voice.name }),
							voice.description && el("small", { textContent: voice.description }),
						]),
					]),
					el("div", { className: "voice-actions" }, actions),
				]),
			);
		}
		if (this.voices.length === 0) list.append(el("p", { className: "muted", textContent: "Loading voices..." }));
		return this.section("Voice", [list, this.addVoiceBlock()]);
	}

	private addVoiceBlock(): HTMLElement {
		const status = el("p", { className: "muted add-voice-status" });
		const record = el("button", {
			type: "button",
			textContent: this.recording ? "Stop recording" : "Record my voice",
			className: this.recording ? "recording" : "",
		});
		record.addEventListener("click", () => void this.toggleRecording(status));
		const file = el("input", { type: "file", accept: "audio/*" });
		file.addEventListener("change", () => void this.useFile(file, status));
		const name = el("input", { type: "text", placeholder: "Name for this voice", maxLength: 40 });
		const save = el("button", { type: "button", className: "primary-lite", textContent: "Save voice" });
		save.addEventListener("click", () => void this.uploadVoice(name.value, status));
		const details = el("details", { className: "add-voice" }, [
			el("summary", { textContent: "Add your own voice" }),
			el("p", {
				className: "muted",
				textContent: `Record ${minRecordSeconds} to ${maxRecordSeconds} seconds in a quiet room, reading this aloud:`,
			}),
			el("blockquote", { textContent: readingText }),
			el("div", { className: "controls" }, [
				record,
				el("label", { className: "file-label" }, ["or upload a file", file]),
			]),
			el("div", { className: "controls" }, [name, save]),
			status,
		]);
		details.open = Boolean(this.recording || this.pendingVoice);
		return details;
	}

	private async toggleRecording(status: HTMLElement): Promise<void> {
		if (this.recording) {
			const recording = this.recording;
			this.recording = undefined;
			const samples = await recording.stop();
			const seconds = samples.length / 24000;
			if (seconds < minRecordSeconds) {
				this.pendingVoice = undefined;
				this.render();
				this.querySelector(".add-voice-status")?.replaceChildren(
					`That was ${seconds.toFixed(0)} s; please record at least ${minRecordSeconds} s.`,
				);
				return;
			}
			this.pendingVoice = encodeWav(samples);
			this.render();
			this.querySelector(".add-voice-status")?.replaceChildren(
				`Recorded ${seconds.toFixed(0)} s. Give it a name and save it.`,
			);
			return;
		}
		try {
			const stream = await navigator.mediaDevices.getUserMedia({
				audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
			});
			const context = new AudioContext();
			const frames: Float32Array[] = [];
			const capture = await createCaptureNode(context, (samples) => frames.push(samples.slice()));
			context.createMediaStreamSource(stream).connect(capture);
			const startedAt = Date.now();
			const timer = setInterval(() => {
				const seconds = Math.floor((Date.now() - startedAt) / 1000);
				this.querySelector(".add-voice-status")?.replaceChildren(`Recording... ${seconds} s`);
				if (seconds >= maxRecordSeconds) void this.toggleRecording(status);
			}, 250);
			this.recording = {
				stop: async () => {
					clearInterval(timer);
					for (const track of stream.getTracks()) track.stop();
					const rate = context.sampleRate;
					await context.close();
					const all = new Float32Array(frames.reduce((sum, frame) => sum + frame.length, 0));
					let offset = 0;
					for (const frame of frames) {
						all.set(frame, offset);
						offset += frame.length;
					}
					return resampleMono(all, rate);
				},
			};
			this.pendingVoice = undefined;
			this.render();
		} catch (error) {
			status.textContent = `Microphone unavailable: ${error instanceof Error ? error.message : String(error)}`;
		}
	}

	private async useFile(input: HTMLInputElement, status: HTMLElement): Promise<void> {
		const file = input.files?.[0];
		if (!file) return;
		try {
			const { samples, sampleRate } = await decodeAudioFile(file);
			const resampled = await resampleMono(samples, sampleRate);
			const seconds = resampled.length / 24000;
			if (seconds < 3) throw new Error("the recording is shorter than 3 seconds");
			// Long files: the first 30 seconds are plenty for cloning.
			this.pendingVoice = encodeWav(resampled.subarray(0, 24000 * maxRecordSeconds));
			status.textContent = `Loaded ${Math.min(seconds, maxRecordSeconds).toFixed(0)} s from ${file.name}. Give it a name and save it.`;
		} catch (error) {
			status.textContent = `Could not read that file: ${error instanceof Error ? error.message : String(error)}`;
		}
	}

	private async uploadVoice(name: string, status: HTMLElement): Promise<void> {
		if (!this.pendingVoice) {
			status.textContent = "Record your voice or choose a file first.";
			return;
		}
		status.textContent = "Saving...";
		try {
			const { voice } = await api<{ voice: VoiceInfo }>(
				"POST",
				`/api/voices?name=${encodeURIComponent(name || "My voice")}`,
				this.pendingVoice,
				"audio/wav",
			);
			this.pendingVoice = undefined;
			this.voices = (await api<{ voices: VoiceInfo[] }>("GET", "/api/voices")).voices;
			await this.save({ voice: voice.id });
			this.notice(`Saved "${voice.name}" and switched to it. Tap Play sample to hear it.`);
		} catch (error) {
			status.textContent = `Could not save the voice: ${error instanceof Error ? error.message : String(error)}`;
		}
	}

	private async removeVoice(voice: VoiceInfo): Promise<void> {
		if (!confirm(`Delete the voice "${voice.name}"?`)) return;
		try {
			await api("DELETE", `/api/voices/${encodeURIComponent(voice.id)}`);
			this.voices = (await api<{ voices: VoiceInfo[] }>("GET", "/api/voices")).voices;
			const { settings } = await api<{ settings: PanelSettings }>("POST", "/api/settings", {});
			if (this.data) this.data.settings = settings;
			this.emit("settings-changed", settings);
			this.render();
		} catch (error) {
			this.notice(`Could not delete: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private speakingSection(data: SettingsPanelData): HTMLElement {
		const value = el("output", { textContent: `${data.settings.speechRate.toFixed(2)}x` });
		const speed = el("input", {
			type: "range",
			min: "0.75",
			max: "1.5",
			step: "0.05",
			value: String(data.settings.speechRate),
		});
		speed.addEventListener("input", () => {
			value.textContent = `${Number(speed.value).toFixed(2)}x`;
		});
		speed.addEventListener("change", () => void this.save({ speechRate: Number(speed.value) }));
		const effect = el("input", { type: "checkbox", checked: data.settings.voiceEffect });
		effect.addEventListener("change", () => void this.save({ voiceEffect: effect.checked }));
		return this.section("Speaking", [
			el("label", { className: "row" }, ["Speed", speed, value]),
			el("label", { className: "row" }, [effect, "Radio-style voice effect (warmer, clearer on phone speakers)"]),
		]);
	}

	private listeningSection(data: SettingsPanelData): HTMLElement {
		const wake = el("input", { type: "checkbox", checked: data.settings.wakeNameOnly });
		wake.addEventListener("change", () => void this.save({ wakeNameOnly: wake.checked }));
		return this.section("Listening", [
			el("label", { className: "row" }, [wake, `Only respond when I say "${data.robotName}"`]),
			el("p", {
				className: "muted",
				textContent: `Useful with a TV or other people talking nearby. Right after ${data.robotName} speaks you can answer without the name.`,
			}),
		]);
	}

	private brainSection(data: SettingsPanelData): HTMLElement {
		const option = (value: "fast" | "smart", title: string, note: string, disabled = false) => {
			const radio = el("input", {
				type: "radio",
				name: "brain",
				value,
				checked: data.settings.brain === value,
				disabled,
			});
			radio.addEventListener("change", () => void this.save({ brain: value }));
			return el("label", { className: `row choice${disabled ? " disabled" : ""}` }, [
				radio,
				el("span", {}, [el("strong", { textContent: title }), el("small", { textContent: note })]),
			]);
		};
		return this.section("Brain", [
			option("fast", "Fast", `${data.brains.fast}. Answers right away.`),
			data.brains.smart
				? option("smart", "Smart", `${data.brains.smart}. Better answers, a few seconds slower to start.`)
				: option("smart", "Smart", "No larger model is configured on the server.", true),
		]);
	}

	private musicSection(data: SettingsPanelData): HTMLElement {
		const volume = el("input", {
			type: "range",
			min: "0.05",
			max: "1",
			step: "0.05",
			value: String(data.radioVolume),
		});
		volume.addEventListener("input", () => this.emit("radio-volume", Number(volume.value)));
		const spotify = el("button", { type: "button", textContent: "Spotify settings" });
		spotify.addEventListener("click", () => this.emit("open-spotify"));
		return this.section("Music", [
			el("label", { className: "row" }, ["Radio volume on this device", volume]),
			el("div", { className: "controls" }, [spotify]),
		]);
	}

	private robotSection(data: SettingsPanelData): HTMLElement {
		const connect = el("button", {
			type: "button",
			textContent: data.robotConnected ? "Robot connected" : "Connect robot",
			disabled: data.robotConnected,
		});
		connect.addEventListener("click", () => this.emit("connect-robot"));
		return this.section("Robot hardware", [
			el("p", {
				className: "muted",
				textContent:
					"For driving: connect the robot's FT232H USB adapter (Chrome or Edge, or Chrome on Android). This also enables the compass for turning.",
			}),
			el("div", { className: "controls" }, [connect]),
		]);
	}

	private accountSection(): HTMLElement {
		const current = el("input", {
			type: "password",
			placeholder: "Current password",
			autocomplete: "current-password",
		});
		const next = el("input", {
			type: "password",
			placeholder: "New password (8+ characters)",
			autocomplete: "new-password",
		});
		const confirmInput = el("input", {
			type: "password",
			placeholder: "New password again",
			autocomplete: "new-password",
		});
		const status = el("p", { className: "muted" });
		const form = el("form", { className: "password-form" }, [
			current,
			next,
			confirmInput,
			el("button", { type: "submit", textContent: "Change password" }),
			status,
		]);
		form.addEventListener("submit", (event) => {
			event.preventDefault();
			if (next.value !== confirmInput.value) {
				status.textContent = "The new passwords do not match.";
				return;
			}
			void api("POST", "/api/password", { current: current.value, next: next.value })
				.then(() => {
					status.textContent = "Password changed. Other devices were signed out.";
					form.reset();
				})
				.catch((error: unknown) => {
					status.textContent = error instanceof Error ? error.message : String(error);
				});
		});
		return this.section("Account", [form]);
	}

	private developerSection(data: SettingsPanelData): HTMLElement {
		const show = el("input", { type: "checkbox", checked: data.showLog });
		show.addEventListener("change", () => {
			data.showLog = show.checked;
			this.emit("show-log", show.checked);
		});
		return this.section("Developer", [el("label", { className: "row" }, [show, "Show the technical log"])]);
	}
}

customElements.define("pibot-settings", SettingsPanelElement);
