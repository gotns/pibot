import OpusScript from "opusscript";

// Opus for the browser link: ~10x less data than raw 16-bit PCM for speech (60 B vs 640 B per 20 ms
// of 16 kHz mic audio). Browsers without WebCodecs keep sending/receiving raw PCM.

const frameMs = 20;
const micSampleRate = 16000;
const speechBitrate = 32000;

export type AudioCodec = "pcm16" | "opus";

export interface MicDecoder {
	decode: (packet: Buffer) => Buffer;
	close: () => void;
}

// Mic audio: one Opus packet per WebSocket message, decoded to the recognizer's 16 kHz PCM16.
export function createMicDecoder(): MicDecoder {
	const decoder = new OpusScript(micSampleRate, 1);
	return {
		decode: (packet) => decoder.decode(packet),
		close: () => decoder.delete(),
	};
}

export interface SpeechEncoder {
	encode: (pcm: Uint8Array) => Buffer[];
	flush: () => Buffer[];
	close: () => void;
}

// Robot speech: the TTS worker's PCM16 blocks, cut into 20 ms Opus packets. A partial frame waits for the
// next block; flush() pads the last one with silence.
export function createSpeechEncoder(sampleRate: 8000 | 12000 | 16000 | 24000 | 48000): SpeechEncoder {
	const encoder = new OpusScript(sampleRate, 1, OpusScript.Application.VOIP);
	encoder.setBitrate(speechBitrate);
	const frameBytes = (sampleRate * frameMs * 2) / 1000;
	let pending = Buffer.alloc(0);
	const drain = (): Buffer[] => {
		const packets: Buffer[] = [];
		while (pending.byteLength >= frameBytes) {
			packets.push(encoder.encode(pending.subarray(0, frameBytes), frameBytes / 2));
			pending = pending.subarray(frameBytes);
		}
		return packets;
	};
	return {
		encode: (pcm) => {
			pending = Buffer.concat([pending, Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)]);
			return drain();
		},
		flush: () => {
			if (pending.byteLength === 0) return [];
			pending = Buffer.concat([pending, Buffer.alloc(frameBytes - pending.byteLength)]);
			return drain();
		},
		close: () => encoder.delete(),
	};
}
