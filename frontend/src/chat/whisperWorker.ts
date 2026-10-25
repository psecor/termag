/// <reference types="vite/client" />
// On-device dictation's speech-to-text (chat/localRecognition.ts): Whisper
// base through transformers.js, on WebGPU where it works and WASM otherwise.
// The model (/termag/speech/, put there by scripts/speech-assets.mjs) and
// the ONNX runtime's WASM (a build asset) come from the orchestrator itself,
// never from a third party (transformers.js defaults to Hugging Face and
// jsDelivr), and stay in the browser's Cache Storage after the first load.
import { env, pipeline, type AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers';
import ortWasm from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url';

export type WhisperRequest =
  | { type: 'load' }
  | { type: 'transcribe'; id: number; audio: Float32Array; language: string | null };

export type WhisperReply =
  | { type: 'progress'; loaded: number; total: number }
  | { type: 'ready' }
  | { type: 'load-failed'; message: string }
  | { type: 'text'; id: number; text: string }
  | { type: 'failed'; id: number; message: string };

const MODEL = 'onnx-community/whisper-base';
env.allowRemoteModels = false;
env.allowLocalModels = true;
// A path, not a URL: transformers.js 4.3 only probes a local model path for
// the optional files (tokenizer, preprocessor) when it is not a URL, and
// without them the pipeline fails on its first run.
env.localModelPath = `${import.meta.env.BASE_URL}speech/models/`;
// The runtime's JS half is bundled with it; only the binary needs a URL.
if (env.backends.onnx.wasm) env.backends.onnx.wasm.wasmPaths = { wasm: new URL(ortWasm, self.location.origin).href };

// The project's lib is the DOM one; this is the part of a worker's scope used here.
const ctx = self as unknown as { postMessage(m: WhisperReply): void; onmessage: ((e: MessageEvent<WhisperRequest>) => void) | null };
const reply = (m: WhisperReply) => ctx.postMessage(m);

// Bytes per model file, for one overall fraction across the downloads.
const files = new Map<string, { loaded: number; total: number }>();
function progress(p: { status: string; file?: string; loaded?: number; total?: number }) {
  if (p.status !== 'progress' || !p.file || !p.total) return;
  files.set(p.file, { loaded: p.loaded ?? 0, total: p.total });
  let loaded = 0;
  let total = 0;
  for (const f of files.values()) { loaded += f.loaded; total += f.total; }
  reply({ type: 'progress', loaded, total });
}

function create(device: 'webgpu' | 'wasm'): Promise<AutomaticSpeechRecognitionPipeline> {
  return pipeline('automatic-speech-recognition', MODEL, { device, dtype: 'q8', progress_callback: progress }) as Promise<AutomaticSpeechRecognitionPipeline>;
}

async function load(): Promise<AutomaticSpeechRecognitionPipeline> {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  if (gpu && await gpu.requestAdapter().catch(() => null)) {
    try {
      const asr = await create('webgpu');
      // Some GPUs build the session and fail on the first run; find out now.
      await asr(new Float32Array(16000));
      return asr;
    } catch { /* fall back to WASM */ }
  }
  return create('wasm');
}

let asr: Promise<AutomaticSpeechRecognitionPipeline> | null = null;

async function transcribe(audio: Float32Array, language: string | null): Promise<string> {
  const run = await asr!;
  const text = (out: unknown) => (Array.isArray(out) ? out[0] : out as { text?: string })?.text ?? '';
  if (language) {
    try {
      return text(await run(audio, { language, task: 'transcribe' }));
    } catch { /* a language Whisper doesn't know: let it detect */ }
  }
  return text(await run(audio, { task: 'transcribe' }));
}

ctx.onmessage = (e: MessageEvent<WhisperRequest>) => {
  const m = e.data;
  if (m.type === 'load') {
    if (!asr) {
      asr = load();
      asr.catch(() => { asr = null; });
    }
    asr.then(() => reply({ type: 'ready' }), err => reply({ type: 'load-failed', message: String(err?.message ?? err) }));
    return;
  }
  if (!asr) {
    reply({ type: 'failed', id: m.id, message: 'not loaded' });
    return;
  }
  transcribe(m.audio, m.language).then(
    text => reply({ type: 'text', id: m.id, text }),
    err => reply({ type: 'failed', id: m.id, message: String(err?.message ?? err) }),
  );
};
