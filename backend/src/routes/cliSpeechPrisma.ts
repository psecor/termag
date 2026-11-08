/** CliSpeech (routes/cliSpeech.ts) over the web build's speech/ folder. */
import { join } from 'path';
import type { CliSpeech } from './cliSpeech';

export function prismaCliSpeech(frontendDist: string): CliSpeech {
  return { dir: join(frontendDist, 'speech') };
}
