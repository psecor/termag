/**
 * Which generation of the shared Bazel cache boxes should read (tech spec,
 * "How a box learns the generation"). The writer publishes
 * `<BAZEL_CACHE_URL>/current-generation`, `{"generation","commit","readyAt"}`,
 * only after a generation's upload is complete. The backend reads it every
 * 5 minutes: an anonymous GET from the orchestrator host, inside the VPC, with
 * a 5 s timeout. It validates the body and the generation's pattern and keeps
 * the last good value; a failed read (a timeout, a 403, bad JSON, a bad name)
 * leaves it. With none at all, the delivery sends no `bazel-cache` step.
 */
import { GENERATION_PATTERN } from './bazelCache';
import { failRoot, traceSweep } from './tracing/spans';

export const GENERATION_POLL_MS = 5 * 60_000;
const READ_TIMEOUT_MS = 5_000;

let current: string | null = null;

/** The last good generation, or null before one has been read. */
export function currentBazelCacheGeneration(): string | null {
  return current;
}

/** For tests. */
export function setBazelCacheGenerationForTest(value: string | null): void {
  current = value;
}

/** The generation in a pointer body, or null with why. */
export function parseGenerationPointer(body: unknown): { generation: string } | { error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'the body is not a JSON object' };
  const g = (body as Record<string, unknown>).generation;
  if (typeof g !== 'string' || !GENERATION_PATTERN.test(g)) return { error: 'its generation is missing or not a generation name' };
  return { generation: g };
}

type Fetch = (url: string, init: { signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/**
 * One read. Returns the generation now held; calls onChange when it differs
 * from the one held before (null to a first value included).
 */
export async function readBazelCacheGeneration(origin: string, onChange: (generation: string) => void, fetchFn: Fetch = fetch as unknown as Fetch): Promise<string | null> {
  let parsed: { generation: string } | { error: string };
  try {
    const res = await fetchFn(`${origin}/current-generation`, { signal: AbortSignal.timeout(READ_TIMEOUT_MS) });
    if (!res.ok) {
      parsed = { error: `S3 answered ${res.status}` };
    } else {
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        body = null;
      }
      parsed = parseGenerationPointer(body);
    }
  } catch (err) {
    if ((err as Error).name === 'TimeoutError') {
      parsed = { error: 'the read timed out' };
    } else {
      // The message stays in the log, out of the span (the server-tracing gotcha).
      console.warn('[BAZEL-CACHE] current-generation request failed:', (err as Error).message);
      parsed = { error: 'the request failed' };
    }
  }
  if ('error' in parsed) {
    console.warn(`[BAZEL-CACHE] could not read current-generation (${parsed.error}); keeping ${current ?? 'none'}`);
    // Caught, not thrown, so the sweep's trace is marked failed by hand and
    // kept (the server-tracing gotcha). The reason is an enum-like phrase, never a body.
    failRoot(new Error(`current-generation read failed: ${parsed.error}`));
    return current;
  }
  if (parsed.generation !== current) {
    const before = current;
    current = parsed.generation;
    console.log(`[BAZEL-CACHE] generation ${before ?? 'none'} -> ${current}`);
    onChange(current);
  }
  return current;
}

/** Reads now and every 5 minutes. Returns the stop. */
export function startBazelCacheGenerationReader(origin: string, onChange: (generation: string) => void, fetchFn?: Fetch): () => void {
  // Its own trace per read (the server-tracing gotcha: a loop of 30 s or slower).
  const tick = traceSweep('bazel-cache-generation', () => readBazelCacheGeneration(origin, onChange, fetchFn));
  void tick();
  const timer = setInterval(() => { void tick(); }, GENERATION_POLL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
