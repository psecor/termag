/**
 * Running an owner's regex on the orchestrator without letting it stall the
 * event loop. Node's
 * regex engine backtracks, and no save-time check can rule out every pattern
 * that backtracks catastrophically (`(a|aa)+$` slips past a nested-quantifier
 * check), so the match runs in a worker thread with a hard time limit: a
 * pattern that takes longer is terminated and counts as no match. The text
 * is capped too, so the limit is rarely the thing that ends it.
 */
import { Worker } from 'node:worker_threads';

export const REGEX_TIME_LIMIT_MS = 250;
export const REGEX_MAX_TEXT = 2000;

const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
let matched = false;
try { matched = new RegExp(workerData.source, workerData.flags).test(workerData.text); } catch { matched = false; }
parentPort.postMessage(matched);
`;

/** Whether the regex matches, or 'timeout' when it ran past the limit (and was stopped). Never throws. */
export function boundedRegexTest(source: string, flags: string, text: string, timeoutMs: number = REGEX_TIME_LIMIT_MS): Promise<boolean | 'timeout'> {
  return new Promise(resolve => {
    let settled = false;
    const done = (v: boolean | 'timeout') => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } };
    let worker: Worker;
    try {
      worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { source, flags, text: text.slice(0, REGEX_MAX_TEXT) }, resourceLimits: { maxOldGenerationSizeMb: 32 } });
    } catch {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => { done('timeout'); void worker.terminate(); }, timeoutMs);
    worker.once('message', (m: unknown) => { done(m === true); void worker.terminate(); });
    worker.once('error', () => done(false));
    worker.once('exit', () => done(false));
  });
}
