// The model on-device dictation runs, put under public/speech/ so the orchestrator serves it itself and
// the browser never fetches one from a third party: Whisper base, 8-bit, from
// Hugging Face at a pinned revision into
// public/speech/models/onnx-community/whisper-base/, each file checked
// against its sha256. A file already there with the right hash is kept, so
// it downloads once per checkout. (The ONNX runtime's WASM is a build asset,
// chat/whisperWorker.ts.)
//
// Run by `npm run build` and `npm run dev`. public/speech/ is gitignored.
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '../public/speech');

const MODEL = 'onnx-community/whisper-base';
const REVISION = '1846881b6b3a3024392c1eea3ad983695bc23925';
const FILES = {
  'config.json': 'f4d0608f7d918166da7edb3e188de5ef1bfe70d9802e785d271fd88111e9cf4b',
  'generation_config.json': '61070cf8de25b1e9256e8e102ded49d8d24a8369ed36ef84fdf21549e68125a0',
  'preprocessor_config.json': 'a6a76d28c93edb273669eb9e0b0636a2bddbb1272c3261e47b7ca6dfdbac1b8d',
  'tokenizer.json': '27fc476bfe7f17299480be2273fc0608e4d5a99aba2ab5dec5374b4482d1a566', // gitleaks:allow (sha256 of a public model file)
  'tokenizer_config.json': '2e036e4dbacfdeb7242c7d4ec4149f4a16e86026048f94d1637e3a8ee9c6a573', // gitleaks:allow (sha256 of a public model file)
  'onnx/encoder_model_quantized.onnx': '5862993336bf33acd23736071aae2b32261d3b1b2f37780194460d4ef974dd46',
  'onnx/decoder_model_merged_quantized.onnx': 'fa3ef9902734ce5ae6f9ef2bdb2ba9a6c4b5785b09f4f420ce036573dc9d090b',
};

const sha256 = buf => createHash('sha256').update(buf).digest('hex');

async function fetchModelFile(name, want) {
  const dest = join(out, 'models', MODEL, name);
  if (existsSync(dest) && sha256(readFileSync(dest)) === want) return;
  mkdirSync(dirname(dest), { recursive: true });
  const url = `https://huggingface.co/${MODEL}/resolve/${REVISION}/${name}`;
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const got = sha256(buf);
      if (got !== want) throw new Error(`sha256 ${got}, expected ${want}`);
      writeFileSync(`${dest}.part`, buf);
      renameSync(`${dest}.part`, dest);
      console.log(`speech-assets: ${name} (${(buf.length / 1e6).toFixed(1)} MB)`);
      return;
    } catch (e) {
      lastError = e;
    }
  }
  throw new Error(`speech-assets: could not fetch ${url}: ${lastError?.message ?? lastError}`);
}

for (const [name, hash] of Object.entries(FILES)) await fetchModelFile(name, hash);
