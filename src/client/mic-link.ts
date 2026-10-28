import type { ClientMessage } from "../types.js";

// Everything between the 16 kHz mic samples and the WebSocket: the mic mode (always listening, muted,
// push-to-talk), a sound gate that keeps silence off the network, and Opus compression where the browser
// has WebCodecs. Together they cut idle upload from ~115 MB/h to almost nothing and speech ~15x.

export type MicMode = "auto" | "muted" | "push-to-talk";
export type AudioCodecName = "pcm16" | "opus";

const sampleRate = 16000;
// Opens on any sound the recognizer could pick up (its own energy gate is 0.002 RMS).
const gateThreshold = 0.0025;
// Must outlast the recognizer's end-of-speech silence (600 ms), so it can end the utterance on its own.
const gateHangoverMs = 1500;
// Soft word onsets sit below the threshold; this much audio before the gate opened goes out with it.
const prerollSamples = Math.round(sampleRate * 0.6);
const encoderConfig: AudioEncoderConfig = { codec: "opus", sampleRate, numberOfChannels: 1, bitrate: 24000 };

export async function detectAudioCodecs(): Promise<{ uplink: AudioCodecName; downlink: AudioCodecName }> {
	const supported = (check: Promise<{ supported?: boolean }> | undefined) =>
		check?.then(
			(result) => Boolean(result.supported),
			() => false,
		) ?? Promise.resolve(false);
	const [encode, decode] = await Promise.all([
		supported(typeof AudioEncoder === "undefined" ? undefined : AudioEncoder.isConfigSupported(encoderConfig)),
		supported(
			typeof AudioDecoder === "undefined"
				? undefined
				: AudioDecoder.isConfigSupported({ codec: "opus", sampleRate: 24000, numberOfChannels: 1 }),
		),
	]);
	return { uplink: encode ? "opus" : "pcm16", downlink: decode ? "opus" : "pcm16" };
}

export interface MicLink {
	uplinkCodec: () => AudioCodecName;
	mode: () => MicMode;
	setMode: (mode: MicMode) => void;
	setPushToTalk: (talking: boolean) => void;
	send: (pcm: Int16Array, bypassGate: boolean) => void;
	reset: () => void;
}

export function createMicLink(deps: {
	uplink: AudioCodecName;
	isOpen: () => boolean;
	sendBinary: (data: Uint8Array<ArrayBuffer>) => void;
	send: (message: ClientMessage) => void;
	log: (text: string) => void;
	onSendingChange: (sending: boolean) => void;
	onUplinkChange: () => void;
}): MicLink {
	let uplink = deps.uplink;
	let mode: MicMode = "auto";
	let pushToTalk = false;
	let gateOpen = false;
	let lastLoudAt = 0;
	const preroll = new Int16Array(prerollSamples);
	let prerollLength = 0;
	let encoder: AudioEncoder | undefined;
	let encodedSamples = 0;

	function createEncoder(): AudioEncoder | undefined {
		if (uplink !== "opus") return undefined;
		const next = new AudioEncoder({
			output: (chunk) => {
				const bytes = new Uint8Array(chunk.byteLength);
				chunk.copyTo(bytes);
				deps.sendBinary(bytes);
			},
			error: (error) => {
				deps.log(`Opus encoder failed, sending raw audio instead: ${error.message}`);
				uplink = "pcm16";
				encoder = undefined;
				deps.onUplinkChange();
			},
		});
		next.configure(encoderConfig);
		encodedSamples = 0;
		return next;
	}
	encoder = createEncoder();

	function transmit(pcm: Int16Array): void {
		if (pcm.length === 0) return;
		if (!encoder || encoder.state !== "configured") {
			const bytes = new Uint8Array(pcm.byteLength);
			bytes.set(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength));
			deps.sendBinary(bytes);
			return;
		}
		const samples = new Float32Array(pcm.length);
		for (let i = 0; i < pcm.length; i++) samples[i] = (pcm[i] ?? 0) / 32768;
		const data = new AudioData({
			format: "f32",
			sampleRate,
			numberOfFrames: samples.length,
			numberOfChannels: 1,
			timestamp: Math.round((encodedSamples / sampleRate) * 1_000_000),
			data: samples,
		});
		encodedSamples += samples.length;
		encoder.encode(data);
		data.close();
	}

	// Sends what the encoder still holds, then tells the server the utterance is over.
	async function flush(): Promise<void> {
		try {
			if (encoder?.state === "configured") await encoder.flush();
		} catch (error) {
			deps.log(`Opus flush failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (deps.isOpen()) deps.send({ type: "mic_flush" });
	}

	function keepPreroll(pcm: Int16Array): void {
		if (pcm.length >= preroll.length) {
			preroll.set(pcm.subarray(pcm.length - preroll.length));
			prerollLength = preroll.length;
			return;
		}
		const keep = Math.min(prerollLength, preroll.length - pcm.length);
		preroll.copyWithin(0, prerollLength - keep, prerollLength);
		preroll.set(pcm, keep);
		prerollLength = keep + pcm.length;
	}

	function setGate(open: boolean): void {
		if (gateOpen === open) return;
		gateOpen = open;
		deps.onSendingChange(open);
	}

	return {
		uplinkCodec: () => uplink,
		mode: () => mode,
		setMode: (next) => {
			if (next === mode) return;
			mode = next;
			pushToTalk = false;
			if (gateOpen) {
				setGate(false);
				void flush();
			}
		},
		setPushToTalk: (talking) => {
			if (mode !== "push-to-talk" || talking === pushToTalk) return;
			pushToTalk = talking;
			deps.onSendingChange(talking);
			// Releasing the button ends the utterance at once; no waiting for silence.
			if (!talking) void flush();
		},
		send: (pcm, bypassGate) => {
			if (!deps.isOpen() || mode === "muted") return;
			if (mode === "push-to-talk") {
				if (pushToTalk || bypassGate) transmit(pcm);
				return;
			}
			if (bypassGate) {
				transmit(pcm);
				return;
			}
			let sum = 0;
			for (const sample of pcm) sum += sample * sample;
			const loud = Math.sqrt(sum / Math.max(1, pcm.length)) / 32768 >= gateThreshold;
			const now = performance.now();
			if (loud) {
				lastLoudAt = now;
				if (!gateOpen) {
					setGate(true);
					transmit(preroll.slice(0, prerollLength));
					prerollLength = 0;
				}
				transmit(pcm);
				return;
			}
			if (gateOpen) {
				transmit(pcm);
				if (now - lastLoudAt > gateHangoverMs) {
					setGate(false);
					void flush();
				}
				return;
			}
			keepPreroll(pcm);
		},
		reset: () => {
			// New connection: the server made a new decoder, so the encoder starts over too.
			if (encoder && encoder.state !== "closed") encoder.close();
			encoder = createEncoder();
			setGate(false);
			prerollLength = 0;
		},
	};
}
