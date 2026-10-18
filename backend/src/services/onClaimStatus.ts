export const ON_CLAIM_RUN_STATES = ['running', 'succeeded', 'failed', 'skipped'] as const;
export type OnClaimRunState = typeof ON_CLAIM_RUN_STATES[number];

export type OnClaimReport =
  | { state: 'running' }
  | { state: 'succeeded' }
  | { state: 'failed'; error: string }
  | { state: 'skipped'; error: string | null };

const MAX_ERROR_LENGTH = 256;
const NEEDS_AUTH_ERROR = 'Dotfiles wait for GitHub login on the box';

/** Read the stable subset of the runner status file forwarded by the agent. */
export function parseOnClaimReport(raw: unknown): OnClaimReport | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const fields = raw as Record<string, unknown>;
  const state = ON_CLAIM_RUN_STATES.find(candidate => candidate === fields.state);
  if (!state) return null;
  if (state === 'running' || state === 'succeeded') return { state };
  if (state === 'skipped') {
    const reason = clean(fields.reason);
    const error = reason === 'needs-auth'
      ? NEEDS_AUTH_ERROR
      : reason;
    return { state, error };
  }

  const reason = clean(fields.reason);
  const logTail = typeof fields.logTail === 'string'
    ? fields.logTail.split(/\r?\n/).map(line => clean(line)).filter(Boolean).at(-1)
    : null;
  return { state, error: (logTail || reason || 'on-claim failed').slice(0, MAX_ERROR_LENGTH) };
}

export function onClaimRunUpdate(instanceId: string, report: OnClaimReport): {
  where: { id: string; status: 'ready' };
  data: { onClaimStatus: OnClaimRunState; onClaimError: string | null };
} {
  const error = report.state === 'failed' || report.state === 'skipped'
    ? report.error
    : null;
  return {
    where: { id: instanceId, status: 'ready' },
    data: { onClaimStatus: report.state, onClaimError: error },
  };
}

function clean(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const result = value.replace(/[\0\r\n]/g, ' ').trim();
  return result || null;
}
