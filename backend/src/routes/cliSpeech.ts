/**
 * The speech model the desktop app's dictation runs on the device:
 * the same Whisper files termag web
 * serves itself from /termag/speech/, for a CLI bearer, since the desktop has
 * no browser session to reach those with. It downloads them once, checks each
 * against the sha256 it pins, and keeps them.
 *
 *   GET /speech/whisper-base/<file>   one of the model's files, as the build put it
 *
 * A device sign-in's only: a box's own token gets 403 `forbidden`, as on the
 * desktop's other routes. Behind `desktop-app-enabled` for the person: off, or
 * a file that isn't one of the model's, and the route answers 404 `not_found`
 * as if it weren't there.
 */
import { join } from 'path';
import type { RequestHandler, Router } from 'express';
import { asyncHandler } from '../middleware/errors';
import type { CliUser } from '../services/cliStore';
import type { CliAuth } from './cliApi';

/** Where frontend/scripts/speech-assets.mjs puts the model, under the build's speech/. */
export const SPEECH_MODEL_DIR = 'models/onnx-community/whisper-base';

/** The model's files: nothing else under speech/ is served here. */
export const SPEECH_MODEL_FILES: ReadonlySet<string> = new Set([
  'config.json',
  'generation_config.json',
  'preprocessor_config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'onnx/encoder_model_quantized.onnx',
  'onnx/decoder_model_merged_quantized.onnx',
]);

export interface CliSpeech {
  /** The web build's speech/ folder (frontend/dist/speech). */
  dir: string;
  /** desktop-app-enabled for the person. */
  desktopOn(user: CliUser): Promise<boolean>;
}

const DEVICE_ONLY = {
  error: "A box's own credentials can't download the desktop's speech model; sign in with `termag login`",
  code: 'forbidden',
};
const NOT_FOUND = { error: 'No such CLI endpoint; this termag CLI may be newer than the orchestrator', code: 'not_found' };

export function mountCliSpeechRoutes(router: Router, speech: CliSpeech, bearer: RequestHandler): void {
  router.get(/^\/speech\/whisper-base\/(.+)$/, bearer, asyncHandler(async (req, res) => {
    const auth = res.locals.cliAuth as CliAuth;
    if (auth.credential.kind !== 'device') { res.status(403).json(DEVICE_ONLY); return; }
    const file = (req.params as Record<string, string>)[0] ?? '';
    if (!SPEECH_MODEL_FILES.has(file) || !(await speech.desktopOn(auth.user))) { res.status(404).json(NOT_FOUND); return; }
    res.set('Cache-Control', 'private, max-age=86400');
    // A build that couldn't fetch the model has none: say so as a 404, never the SPA's HTML.
    res.sendFile(join(speech.dir, SPEECH_MODEL_DIR, file), { dotfiles: 'deny' }, (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: 'The speech model is not on this orchestrator', code: 'not_found' });
    });
  }));
}
