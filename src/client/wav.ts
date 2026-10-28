// Turns recorded or uploaded audio into the format voice cloning wants: 24 kHz mono 16-bit WAV.

const voiceSampleRate = 24000;

export async function resampleMono(samples: Float32Array, fromRate: number): Promise<Float32Array> {
	if (fromRate === voiceSampleRate) return samples;
	const length = Math.ceil((samples.length * voiceSampleRate) / fromRate);
	const offline = new OfflineAudioContext(1, length, voiceSampleRate);
	const buffer = offline.createBuffer(1, samples.length, fromRate);
	buffer.getChannelData(0).set(samples);
	const source = offline.createBufferSource();
	source.buffer = buffer;
	source.connect(offline.destination);
	source.start();
	return (await offline.startRendering()).getChannelData(0);
}

// Any file the browser can decode (wav, mp3, m4a, ogg...), mixed down to mono.
export async function decodeAudioFile(file: Blob): Promise<{ samples: Float32Array; sampleRate: number }> {
	const context = new OfflineAudioContext(1, 1, voiceSampleRate);
	const decoded = await context.decodeAudioData(await file.arrayBuffer());
	const mono = new Float32Array(decoded.length);
	for (let channel = 0; channel < decoded.numberOfChannels; channel++) {
		const data = decoded.getChannelData(channel);
		for (let i = 0; i < data.length; i++) mono[i] = (mono[i] ?? 0) + (data[i] ?? 0) / decoded.numberOfChannels;
	}
	return { samples: mono, sampleRate: decoded.sampleRate };
}

export function encodeWav(samples: Float32Array, sampleRate = voiceSampleRate): Blob {
	const buffer = new ArrayBuffer(44 + samples.length * 2);
	const view = new DataView(buffer);
	const text = (offset: number, value: string) => {
		for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
	};
	text(0, "RIFF");
	view.setUint32(4, 36 + samples.length * 2, true);
	text(8, "WAVE");
	text(12, "fmt ");
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, 1, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * 2, true);
	view.setUint16(32, 2, true);
	view.setUint16(34, 16, true);
	text(36, "data");
	view.setUint32(40, samples.length * 2, true);
	for (let i = 0; i < samples.length; i++) {
		const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
		view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
	}
	return new Blob([buffer], { type: "audio/wav" });
}
