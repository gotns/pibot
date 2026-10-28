// Captures audio on the audio thread (AudioWorklet) and hands it to the main thread in 1024-sample
// frames. Replaces the deprecated ScriptProcessorNode, which ran on the main thread and glitched when the
// page was busy. The processor is loaded from a Blob URL, so no extra file has to be served.

const processorName = "pibot-capture";
const processorSource = `
class PibotCapture extends AudioWorkletProcessor {
	constructor() {
		super();
		this.frame = new Float32Array(1024);
		this.length = 0;
		this.silence = new Float32Array(128);
	}
	process(inputs) {
		// An idle source (a muted or stopped track) delivers no channels at all. Pass that on as silence:
		// the recognizer needs to hear the quiet after speech to know the utterance has ended.
		const input = (inputs[0] && inputs[0][0]) || this.silence;
		for (let i = 0; i < input.length; i++) {
			this.frame[this.length++] = input[i];
			if (this.length === this.frame.length) {
				const out = this.frame;
				this.port.postMessage(out, [out.buffer]);
				this.frame = new Float32Array(1024);
				this.length = 0;
			}
		}
		return true;
	}
}
registerProcessor("${processorName}", PibotCapture);
`;

const loaded = new WeakMap<BaseAudioContext, Promise<void>>();

function loadProcessor(context: BaseAudioContext): Promise<void> {
	let loading = loaded.get(context);
	if (!loading) {
		const url = URL.createObjectURL(new Blob([processorSource], { type: "application/javascript" }));
		loading = context.audioWorklet.addModule(url).finally(() => URL.revokeObjectURL(url));
		loaded.set(context, loading);
	}
	return loading;
}

// Returns a node that calls onFrame for every 1024 samples it receives. It outputs silence and must stay
// connected towards the destination, or some browsers stop running it.
export async function createCaptureNode(
	context: AudioContext,
	onFrame: (samples: Float32Array, sampleRate: number) => void,
): Promise<AudioNode> {
	if (!context.audioWorklet) {
		// Very old browsers: fall back to the main-thread processor.
		const processor = context.createScriptProcessor(1024, 1, 1);
		processor.onaudioprocess = (event) => onFrame(event.inputBuffer.getChannelData(0), context.sampleRate);
		processor.connect(context.destination);
		return processor;
	}
	await loadProcessor(context);
	const node = new AudioWorkletNode(context, processorName, { numberOfOutputs: 1, outputChannelCount: [1] });
	node.port.onmessage = (event: MessageEvent<Float32Array>) => onFrame(event.data, context.sampleRate);
	const silent = context.createGain();
	silent.gain.value = 0;
	node.connect(silent);
	silent.connect(context.destination);
	return node;
}
