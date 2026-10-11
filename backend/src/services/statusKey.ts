/**
 * In-memory status identity.
 *
 * Tmux session names omit the box (`<user>-<project>[-<workstream>]-<role>`),
 * and the schema allows the same project name on two instances
 * (`@@unique([userId, instanceId, name])`). The map key is therefore
 * `(instanceId, session)`, not the session name alone.
 *
 * '|' is the separator: it does not appear in instance ids or session names.
 * A null instance (the orchestrator / loopback writer) is the empty prefix,
 * so the host key is `|alice-cx-agent` and a box key is `box-a|alice-cx-agent`.
 * The frontend `statusKey` in `frontend/src/utils/statusKey.ts` must match.
 */
export function statusKey(instanceId: string | null, session: string): string {
  return `${instanceId ?? ''}|${session}`;
}

export function parseStatusKey(key: string): { instanceId: string | null; session: string } {
  const i = key.indexOf('|');
  if (i < 0) return { instanceId: null, session: key };
  const raw = key.slice(0, i);
  return { instanceId: raw === '' ? null : raw, session: key.slice(i + 1) };
}
