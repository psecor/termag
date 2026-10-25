/**
 * What "Run now" tells the owner when the POST did not start a run. The
 * route (backend routes/automations.ts runNowFor) answers 202 for a start,
 * 409 `{run, decision}` when the admit rules skipped it (box asleep, a run
 * already live, budget) and 502 `{error, run, decision}` when the start
 * failed on the box; axios rejects both refusals, so the reason lives on
 * the error's response. Null for anything else (the caller's fallback).
 */
interface RefusalBody {
  error?: string;
  run?: { reasonLabel?: string | null } | null;
  decision?: { kind?: string; reason?: string; error?: string };
}

export function runNowRefusal(err: unknown): string | null {
  const res = (err as { response?: { status?: number; data?: RefusalBody } } | null)?.response;
  const body = res?.data;
  if (!body || typeof body !== 'object') return null;
  if (body.decision?.kind === 'skip') return `Not started: ${body.run?.reasonLabel || body.decision.reason || 'skipped'}`;
  if (body.decision?.kind === 'failed') return `Not started: ${body.error || body.decision.error || 'the run failed to start'}`;
  return null;
}
