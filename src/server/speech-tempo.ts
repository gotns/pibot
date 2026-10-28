// Changes speaking speed without changing pitch (WSOLA: overlap-add of input frames re-spaced in time,
// each shifted within a small window to line up with the previous one). Qwen3-TTS has no speed control,
// and doing it here keeps it independent of the TTS engine. Streaming: works on the TTS worker's PCM
// blocks as they arrive and keeps the overlap state between them.

const frameMs = 30;
const searchMs = 8;

export const minSpeechRate = 0.75;
export const maxSpeechRate = 1.5;

export interface SpeechTempo {
	process: (pcm: Uint8Array) => Uint8Array;
	flush: () => Uint8Array;
}

function toPcm16(samples: Float32Array): Uint8Array {
	const out = new Uint8Array(samples.length * 2);
	const view = new DataView(out.buffer);
	for (let i = 0; i < samples.length; i++) {
		const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
		view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
	}
	return out;
}

export function createSpeechTempo(rate: number, sampleRate: number): SpeechTempo | undefined {
	if (Math.abs(rate - 1) < 0.01) return undefined;
	const frame = Math.round((sampleRate * frameMs) / 1000 / 2) * 2;
	const synthesisHop = frame / 2;
	const analysisHop = synthesisHop * Math.max(minSpeechRate, Math.min(maxSpeechRate, rate));
	const search = Math.round((sampleRate * searchMs) / 1000);
	// Periodic Hann at 50% overlap sums to exactly 1, so overlap-add keeps the level.
	const window = new Float32Array(frame);
	for (let i = 0; i < frame; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / frame);

	let input = new Float32Array(0);
	let inputStart = 0; // absolute sample index of input[0]
	let nextAnalysis = search; // ideal absolute start of the next input frame
	let previousNatural = -1; // where the last chosen frame naturally continues
	let tail = new Float32Array(synthesisHop);

	const at = (absolute: number) => input[absolute - inputStart] ?? 0;

	function bestStart(ideal: number): number {
		if (previousNatural < 0) return ideal;
		let best = ideal;
		let bestScore = Number.NEGATIVE_INFINITY;
		for (let candidate = ideal - search; candidate <= ideal + search; candidate += 2) {
			if (candidate < inputStart) continue;
			let score = 0;
			for (let i = 0; i < synthesisHop; i += 2) score += at(candidate + i) * at(previousNatural + i);
			if (score > bestScore) {
				bestScore = score;
				best = candidate;
			}
		}
		return best;
	}

	const tempo: SpeechTempo = {
		process: (pcm) => {
			const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
			const added = new Float32Array(Math.floor(pcm.byteLength / 2));
			for (let i = 0; i < added.length; i++) added[i] = view.getInt16(i * 2, true) / 32768;
			const merged = new Float32Array(input.length + added.length);
			merged.set(input);
			merged.set(added, input.length);
			input = merged;
			const output: number[] = [];
			while (Math.round(nextAnalysis) + search + frame <= inputStart + input.length) {
				const start = bestStart(Math.round(nextAnalysis));
				for (let i = 0; i < synthesisHop; i++) output.push((tail[i] ?? 0) + at(start + i) * (window[i] ?? 0));
				const nextTail = new Float32Array(synthesisHop);
				for (let i = 0; i < synthesisHop; i++) {
					nextTail[i] = at(start + synthesisHop + i) * (window[synthesisHop + i] ?? 0);
				}
				tail = nextTail;
				previousNatural = start + synthesisHop;
				nextAnalysis += analysisHop;
			}
			// Drop input no later frame can reach.
			const keepFrom = Math.min(
				previousNatural < 0 ? inputStart : previousNatural,
				Math.round(nextAnalysis) - search,
			);
			if (keepFrom > inputStart) {
				input = input.slice(keepFrom - inputStart);
				inputStart = keepFrom;
			}
			return toPcm16(Float32Array.from(output));
		},
		// Pads with silence so the last frames (the end of the final word) are processed too.
		flush: () => {
			const padded = tempo.process(new Uint8Array((search + frame) * 2));
			const rest = toPcm16(tail);
			tail = new Float32Array(synthesisHop);
			const out = new Uint8Array(padded.byteLength + rest.byteLength);
			out.set(padded);
			out.set(rest, padded.byteLength);
			return out;
		},
	};
	return tempo;
}
