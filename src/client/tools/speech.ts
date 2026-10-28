import type { RobotRpcMap } from "../../types.js";
import { createCaptureNode } from "../audio-capture.js";
import type { ClientLogger } from "../logger.js";

const pcmInitialPrebufferSeconds = 0.4;
const pcmScheduleLeadSeconds = 0.02;

interface ActiveSpeech {
	generation: number;
	resolve: (response: RobotRpcMap["speak"]["response"]) => void;
	signal: AbortSignal;
	onAbort: () => void;
	finished: boolean;
}

interface ActivePcmStream {
	generation: number;
	sampleRate: number;
	nextPlayTime: number | undefined;
	pendingSources: number;
	doneRequested: boolean;
	finishResolve: (() => void) | undefined;
	nodes: AudioNode[];
	cleanup: () => void;
	lastChunkWallTime: number | undefined;
	underruns: number;
	chunks: number;
	// Set when the server sends Opus (WebCodecs); raw PCM streams never create one.
	decoder: AudioDecoder | undefined;
	opusPackets: number;
	// First node speech chunks connect to: the clarity filter, or the output when it is off.
	entry: AudioNode;
}

export interface SpeechTool {
	enableTts: () => void;
	cancelSpeech: (reason: string) => void;
	cancelSpeechForBargeIn: () => void;
	handleSpeak: (
		payload: RobotRpcMap["speak"]["request"],
		signal: AbortSignal,
	) => Promise<RobotRpcMap["speak"]["response"]>;
	handleCancelSpeech: (
		payload: RobotRpcMap["cancel_speech"]["request"],
		signal: AbortSignal,
	) => RobotRpcMap["cancel_speech"]["response"];
	startPcmStream: (sampleRate: number) => void;
	setVoiceEffect: (enabled: boolean) => void;
	unlock: () => void;
	pushPcmAudio: (pcm: Uint8Array) => void;
	pushOpusAudio: (packet: Uint8Array) => void;
	finishPcmStream: () => Promise<void>;
	failPcmStream: (message: string) => void;
}

interface FaceAmplitudeElement extends HTMLElement {
	amplitude: number;
}

function setFaceAmplitude(face: HTMLElement, value: number): void {
	const clamped = Math.max(0, Math.min(1, value));
	if ("amplitude" in face) {
		(face as FaceAmplitudeElement).amplitude = clamped;
		return;
	}
	face.style.setProperty("--amp", clamped.toFixed(3));
}

export function createSpeechTool(deps: {
	logger: ClientLogger;
	face: HTMLElement;
	setMicInputBlockedUntil: (time: number) => void;
	onSpeakingChange: (speaking: boolean) => void;
	onPlaybackAudio: (samples: Float32Array, sampleRate: number) => void;
}): SpeechTool {
	const logger = deps.logger.tag("stt");
	const ttsEnabledKey = "robot-tts-enabled";
	let ttsEnabled = localStorage.getItem(ttsEnabledKey) === "true";
	let currentTtsAudio: HTMLAudioElement | undefined;
	let robotVoiceEffectCleanup: (() => void) | undefined;
	let audioContext: AudioContext | undefined;
	let ttsGeneration = 0;
	let activeSpeech: ActiveSpeech | undefined;
	let activePcmStream: ActivePcmStream | undefined;
	// Feeds played speech to the barge-in detector (its echo reference); one per audio context.
	let playbackTap: Promise<AudioNode> | undefined;
	// The clarity filter (EQ + compressor) on robot speech; off plays the voice untouched.
	let voiceEffect = true;
	function startFaceAmpLoop(analyser: AnalyserNode): () => void {
		const data = new Uint8Array(analyser.fftSize);
		let smoothed = 0;
		let frameHandle = 0;
		let stopped = false;
		const tick = () => {
			if (stopped) return;
			analyser.getByteTimeDomainData(data);
			let sum = 0;
			for (const sample of data) {
				const centered = (sample - 128) / 128;
				sum += centered * centered;
			}
			const rms = Math.sqrt(sum / data.length);
			const amp = Math.min(1, rms * 3.4);
			smoothed = smoothed * 0.55 + amp * 0.45;
			setFaceAmplitude(deps.face, smoothed);
			frameHandle = requestAnimationFrame(tick);
		};
		frameHandle = requestAnimationFrame(tick);
		return () => {
			stopped = true;
			cancelAnimationFrame(frameHandle);
			setFaceAmplitude(deps.face, 0);
		};
	}

	function clearCurrentTtsAudio(): void {
		robotVoiceEffectCleanup?.();
		robotVoiceEffectCleanup = undefined;
		if (!currentTtsAudio) return;
		currentTtsAudio.onplay = null;
		currentTtsAudio.onended = null;
		currentTtsAudio.onerror = null;
		currentTtsAudio.pause();
		currentTtsAudio.removeAttribute("src");
		currentTtsAudio.load();
		currentTtsAudio = undefined;
	}

	function createRobotVoiceEffect(audio: HTMLAudioElement): void {
		try {
			audioContext ??= new AudioContext();
			void audioContext.resume();
			const source = audioContext.createMediaElementSource(audio);
			const highpass = audioContext.createBiquadFilter();
			highpass.type = "highpass";
			highpass.frequency.value = 150;
			const lowpass = audioContext.createBiquadFilter();
			lowpass.type = "lowpass";
			lowpass.frequency.value = 7200;
			const presence = audioContext.createBiquadFilter();
			presence.type = "peaking";
			presence.frequency.value = 2600;
			presence.Q.value = 0.9;
			presence.gain.value = 3.5;
			const compressor = audioContext.createDynamicsCompressor();
			compressor.threshold.value = -24;
			compressor.knee.value = 18;
			compressor.ratio.value = 3;
			compressor.attack.value = 0.006;
			compressor.release.value = 0.12;
			const dry = audioContext.createGain();
			dry.gain.value = 0.9;
			const ringModulator = audioContext.createGain();
			ringModulator.gain.value = 0;
			const ringWet = audioContext.createGain();
			ringWet.gain.value = 0.09;
			const ringOsc = audioContext.createOscillator();
			ringOsc.type = "sine";
			ringOsc.frequency.value = 42;
			ringOsc.connect(ringModulator.gain);
			ringOsc.start();
			const slap = audioContext.createDelay(0.25);
			slap.delayTime.value = 0.075;
			const slapWet = audioContext.createGain();
			slapWet.gain.value = 0.045;
			const output = audioContext.createGain();
			output.gain.value = 0.98;
			const analyser = audioContext.createAnalyser();
			analyser.fftSize = 512;
			analyser.smoothingTimeConstant = 0.55;

			source.connect(highpass);
			highpass.connect(lowpass);
			lowpass.connect(presence);
			presence.connect(compressor);
			compressor.connect(dry);
			compressor.connect(ringModulator);
			ringModulator.connect(ringWet);
			dry.connect(output);
			ringWet.connect(output);
			dry.connect(slap);
			slap.connect(slapWet);
			slapWet.connect(output);
			output.connect(audioContext.destination);
			output.connect(analyser);

			const stopAmpLoop = startFaceAmpLoop(analyser);

			robotVoiceEffectCleanup = () => {
				stopAmpLoop();
				try {
					ringOsc.stop();
				} catch {
					// already stopped
				}
				for (const node of [
					source,
					highpass,
					lowpass,
					presence,
					compressor,
					dry,
					ringModulator,
					ringWet,
					ringOsc,
					slap,
					slapWet,
					output,
					analyser,
				]) {
					node.disconnect();
				}
			};
			logger.log("Robot voice effect enabled");
		} catch (error) {
			robotVoiceEffectCleanup = undefined;
			logger.log(`Robot voice effect unavailable: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	function clearActivePcmStream(resolveFinished: boolean): void {
		const stream = activePcmStream;
		activePcmStream = undefined;
		if (!stream) return;
		stream.cleanup();
		for (const node of stream.nodes) node.disconnect();
		if (stream.decoder && stream.decoder.state !== "closed") stream.decoder.close();
		if (resolveFinished) stream.finishResolve?.();
	}

	function maybeFinishPcmStream(stream: ActivePcmStream): void {
		if (activePcmStream !== stream || !stream.doneRequested || stream.pendingSources > 0) return;
		clearActivePcmStream(true);
		deps.onSpeakingChange(false);
		deps.setMicInputBlockedUntil(Date.now() + 500);
		logger.log("Qwen3 PCM stream finished");
	}

	function interruptTtsOnly(resolvePcmFinished = true): void {
		ttsGeneration++;
		clearCurrentTtsAudio();
		clearActivePcmStream(resolvePcmFinished);
		if ("speechSynthesis" in window) window.speechSynthesis.cancel();
	}

	function completeActiveSpeech(response: RobotRpcMap["speak"]["response"]): void {
		const active = activeSpeech;
		if (!active || active.finished) return;
		active.finished = true;
		active.signal.removeEventListener("abort", active.onAbort);
		activeSpeech = undefined;
		active.resolve(response);
	}

	function cancelSpeech(reason: string): void {
		interruptTtsOnly();
		deps.onSpeakingChange(false);
		completeActiveSpeech({ ok: true });
		deps.setMicInputBlockedUntil(Date.now() + 500);
		logger.log(`TTS cancelled: ${reason}`);
	}

	function cancelSpeechForBargeIn(): void {
		interruptTtsOnly(false);
		deps.onSpeakingChange(false);
		completeActiveSpeech({ ok: true });
		deps.setMicInputBlockedUntil(0);
		logger.log("TTS cancelled: barge-in");
	}

	function enableTts(): void {
		ttsEnabled = true;
		localStorage.setItem(ttsEnabledKey, "true");
	}

	function finishTts(message: string): void {
		clearCurrentTtsAudio();
		deps.onSpeakingChange(false);
		completeActiveSpeech({ ok: true });
		deps.setMicInputBlockedUntil(Date.now() + 500);
		logger.log(message);
	}

	function startSpeech(url: string, text: string, generation: number): void {
		const trimmed = text.trim();
		if (!trimmed) {
			finishTts("TTS skipped: empty text");
			return;
		}

		const providerLabel = "Qwen3 local clone";
		clearCurrentTtsAudio();
		deps.onSpeakingChange(true);
		deps.setMicInputBlockedUntil(0);

		const audio = new Audio(url);
		currentTtsAudio = audio;
		createRobotVoiceEffect(audio);
		audio.onplay = () => logger.log(`${providerLabel} playing streamed response ${trimmed.length} chars`);
		audio.onended = () => {
			if (generation !== ttsGeneration) return;
			finishTts(`${providerLabel} finished, resetting STT`);
		};
		audio.onerror = () => {
			if (generation !== ttsGeneration) return;
			finishTts(`${providerLabel} failed, resetting STT`);
		};
		audio.play().catch((error: unknown) => {
			if (generation !== ttsGeneration) return;
			finishTts(
				`${providerLabel} play failed, resetting STT: ${error instanceof Error ? error.message : String(error)}`,
			);
		});
	}

	async function handleSpeak(
		payload: RobotRpcMap["speak"]["request"],
		signal: AbortSignal,
	): Promise<RobotRpcMap["speak"]["response"]> {
		if (!ttsEnabled) return { ok: true };
		if (activeSpeech) cancelSpeech("new speech request");
		return await new Promise<RobotRpcMap["speak"]["response"]>((resolve) => {
			const generation = ++ttsGeneration;
			const onAbort = () => cancelSpeech(String(signal.reason ?? "aborted"));
			activeSpeech = { generation, resolve, signal, onAbort, finished: false };
			signal.addEventListener("abort", onAbort, { once: true });
			if (signal.aborted) {
				onAbort();
				return;
			}
			startSpeech(payload.url, payload.text, generation);
		});
	}

	function handleCancelSpeech(
		payload: RobotRpcMap["cancel_speech"]["request"],
		_signal: AbortSignal,
	): RobotRpcMap["cancel_speech"]["response"] {
		cancelSpeech(payload.reason);
		return { ok: true };
	}

	function startPcmStream(sampleRate: number): void {
		interruptTtsOnly();
		if (!audioContext) audioContext = new AudioContext();
		const context = audioContext;
		void context.resume();
		const highpass = context.createBiquadFilter();
		highpass.type = "highpass";
		highpass.frequency.value = 150;
		const lowpass = context.createBiquadFilter();
		lowpass.type = "lowpass";
		lowpass.frequency.value = 7200;
		const presence = context.createBiquadFilter();
		presence.type = "peaking";
		presence.frequency.value = 2600;
		presence.Q.value = 0.9;
		presence.gain.value = 3.5;
		const compressor = context.createDynamicsCompressor();
		compressor.threshold.value = -24;
		compressor.knee.value = 18;
		compressor.ratio.value = 3;
		compressor.attack.value = 0.006;
		compressor.release.value = 0.12;
		const output = context.createGain();
		output.gain.value = 0.98;
		const analyser = context.createAnalyser();
		analyser.fftSize = 512;
		analyser.smoothingTimeConstant = 0.55;
		playbackTap ??= createCaptureNode(context, deps.onPlaybackAudio);
		highpass.connect(lowpass);
		lowpass.connect(presence);
		presence.connect(compressor);
		compressor.connect(output);
		output.connect(context.destination);
		output.connect(analyser);
		const stream: ActivePcmStream = {
			generation: ++ttsGeneration,
			sampleRate,
			nextPlayTime: undefined,
			pendingSources: 0,
			doneRequested: false,
			finishResolve: undefined,
			nodes: [highpass, lowpass, presence, compressor, output, analyser],
			cleanup: startFaceAmpLoop(analyser),
			lastChunkWallTime: undefined,
			underruns: 0,
			chunks: 0,
			decoder: undefined,
			opusPackets: 0,
			entry: voiceEffect ? highpass : output,
		};
		activePcmStream = stream;
		void playbackTap
			.then((tap) => {
				if (activePcmStream === stream) output.connect(tap);
			})
			.catch((error: unknown) => logger.log(`playback tap unavailable: ${String(error)}`));
		deps.onSpeakingChange(true);
		deps.setMicInputBlockedUntil(0);
		logger.log(`Qwen3 PCM stream started sampleRate=${sampleRate} prebufferMs=${pcmInitialPrebufferSeconds * 1000}`);
	}

	function pushPcmAudio(pcm: Uint8Array): void {
		const stream = activePcmStream;
		if (!stream || pcm.byteLength < 2) return;
		const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
		const samples = new Float32Array(Math.floor(pcm.byteLength / 2));
		for (let index = 0; index < samples.length; index++) samples[index] = view.getInt16(index * 2, true) / 32768;
		scheduleSamples(stream, samples, stream.sampleRate, pcm.byteLength);
	}

	function pushOpusAudio(packet: Uint8Array): void {
		const stream = activePcmStream;
		if (!stream || packet.byteLength === 0) return;
		if (!stream.decoder) {
			const decoder = new AudioDecoder({
				output: (data) => {
					const samples = new Float32Array(data.numberOfFrames);
					data.copyTo(samples, { planeIndex: 0, format: "f32-planar" });
					const rate = data.sampleRate;
					data.close();
					if (activePcmStream === stream) scheduleSamples(stream, samples, rate, packet.byteLength);
				},
				error: (error) => logger.log(`Opus speech decoder error: ${error.message}`),
			});
			decoder.configure({ codec: "opus", sampleRate: stream.sampleRate, numberOfChannels: 1 });
			stream.decoder = decoder;
		}
		const bytes = new Uint8Array(packet.byteLength);
		bytes.set(packet);
		stream.decoder.decode(
			new EncodedAudioChunk({ type: "key", timestamp: stream.opusPackets++ * 20_000, data: bytes }),
		);
	}

	function scheduleSamples(
		stream: ActivePcmStream,
		samples: Float32Array,
		sampleRate: number,
		wireBytes: number,
	): void {
		if (!audioContext || samples.length === 0) return;
		const audioBuffer = audioContext.createBuffer(1, samples.length, sampleRate);
		audioBuffer.getChannelData(0).set(samples);
		const now = performance.now();
		stream.chunks++;
		const arrivalGapMs = stream.lastChunkWallTime === undefined ? 0 : now - stream.lastChunkWallTime;
		stream.lastChunkWallTime = now;
		if (stream.nextPlayTime === undefined)
			stream.nextPlayTime = audioContext.currentTime + pcmInitialPrebufferSeconds;
		const queuedMs = (stream.nextPlayTime - audioContext.currentTime) * 1000;
		if (stream.chunks === 1 || queuedMs < 50 || arrivalGapMs > 250) {
			logger.log(
				`Qwen3 audio chunk #${stream.chunks} wireBytes=${wireBytes} durationMs=${(audioBuffer.duration * 1000).toFixed(1)} queuedMs=${queuedMs.toFixed(1)} arrivalGapMs=${arrivalGapMs.toFixed(1)} pending=${stream.pendingSources}`,
			);
		}
		const source = audioContext.createBufferSource();
		source.buffer = audioBuffer;
		source.connect(stream.entry);
		stream.pendingSources++;
		source.onended = () => {
			source.disconnect();
			stream.pendingSources--;
			maybeFinishPcmStream(stream);
		};
		const underrunMs = (audioContext.currentTime + pcmScheduleLeadSeconds - stream.nextPlayTime) * 1000;
		if (underrunMs > 0) {
			stream.underruns++;
			logger.log(
				`Qwen3 PCM underrun #${stream.underruns}: lateByMs=${underrunMs.toFixed(1)} chunk=${stream.chunks} arrivalGapMs=${arrivalGapMs.toFixed(1)}`,
			);
		}
		const startAt = Math.max(stream.nextPlayTime, audioContext.currentTime + pcmScheduleLeadSeconds);
		source.start(startAt);
		stream.nextPlayTime = startAt + audioBuffer.duration;
	}

	async function finishPcmStream(): Promise<void> {
		const stream = activePcmStream;
		if (!stream) return;
		// Opus: the last packets are still decoding; their audio must be scheduled before "done" counts.
		if (stream.decoder?.state === "configured") {
			await stream.decoder.flush().catch((error: unknown) => logger.log(`Opus flush failed: ${String(error)}`));
		}
		if (activePcmStream !== stream) return;
		stream.doneRequested = true;
		if (stream.pendingSources === 0) {
			maybeFinishPcmStream(stream);
			return;
		}
		await new Promise<void>((resolve) => {
			stream.finishResolve = resolve;
		});
	}

	function failPcmStream(message: string): void {
		clearActivePcmStream(true);
		deps.onSpeakingChange(false);
		deps.setMicInputBlockedUntil(Date.now() + 500);
		logger.log(`Qwen3 PCM stream failed: ${message}`);
	}

	return {
		enableTts,
		cancelSpeech,
		cancelSpeechForBargeIn,
		handleSpeak,
		handleCancelSpeech,
		startPcmStream,
		pushPcmAudio,
		pushOpusAudio,
		setVoiceEffect: (enabled: boolean) => {
			voiceEffect = enabled;
		},
		// Call inside a tap: browsers only let audio start from a user gesture (voice previews on Home).
		unlock: () => {
			audioContext ??= new AudioContext();
			void audioContext.resume();
		},
		finishPcmStream,
		failPcmStream,
	};
}
