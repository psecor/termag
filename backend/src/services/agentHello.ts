// Parser for the `hello` frame an agent sends on connect.
//
// The payload is agent-supplied and flows into a DB write and, from there,
// into `mkdir` and `git worktree add` paths on a box, so it is validated here
// at the boundary. Kept free of Prisma so it can be unit-tested.

export interface AgentHello {
  unixUser: string;
  home: string;
  hostname: string | null;
  agentVersion: string | null;
  // The commit of the checkout the agent process runs from (full sha), so the
  // orchestrator can tell a box that is behind from one that is current
  // (services/boxUpdate). Null from an agent too old to send it, or one
  // running outside a git checkout.
  agentCommit: string | null;
  /** When that commit was made, from the agent's own git; null from an older agent. Sorts the Fleet table by agent age. */
  agentCommitAt: Date | null;
  warm: boolean;
  // Optional features the agent implements; older agents send none.
  capabilities: string[];
  /** Disk, memory, load and kept checkouts, from an agent that samples them; null from an older agent. */
  host: HostSample | null;
}

const MAX_FIELD_LENGTH = 512;

/** Host pressure as the agent samples it (agent/host-sample.js); each field null when the agent could not read it. */
export interface HostSample {
  diskUsedPct: number | null;
  memUsedPct: number | null;
  load1: number | null;
  keptCheckouts: number | null;
  /** The box's size; absent from agents that predate spawn telemetry. */
  cores: number | null;
  memTotalMb: number | null;
}

const pct = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 100 ? v : null);
const count = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 1_000_000 ? v : null);
const load = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 100_000 ? Math.round(v * 100) / 100 : null);

/** The `host` object of a hello or a host-sample reply; null when absent or not an object. */
export function parseHostSample(value: unknown): HostSample | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const h = value as Record<string, unknown>;
  return {
    diskUsedPct: pct(h.diskUsedPct), memUsedPct: pct(h.memUsedPct), load1: load(h.load1), keptCheckouts: count(h.keptCheckouts),
    cores: count(h.cores) || null, memTotalMb: count(h.memTotalMb) || null,
  };
}

export function parseAgentHello(msg: unknown): AgentHello | null {
  if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) return null;
  const fields = msg as Record<string, unknown>;
  if (fields.type !== 'hello') return null;

  const unixUser = pathSafeString(fields.unixUser);
  if (!unixUser) return null;

  const home = pathSafeString(fields.home);
  if (!home || !home.startsWith('/')) return null;

  return {
    unixUser,
    home,
    hostname: optionalString(fields.hostname),
    agentVersion: optionalString(fields.agentVersion),
    agentCommit: commitString(fields.agentCommit),
    agentCommitAt: commitDate(fields.agentCommitAt),
    warm: fields.warm === true,
    capabilities: Array.isArray(fields.capabilities)
      ? fields.capabilities.filter((c): c is string => typeof c === 'string' && /^[a-z0-9-]{1,64}$/.test(c)).slice(0, 32)
      : [],
    host: parseHostSample(fields.host),
  };
}

// Rejects anything that would be unsafe to splice into a filesystem path:
// NUL and newlines (which survive shell quoting badly and break log lines)
// and `..` segments (which escape the directory the caller intends).
function pathSafeString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (value.length > MAX_FIELD_LENGTH) return null;
  if (/[\0\n\r]/.test(value)) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.split('/').includes('..')) return null;
  return trimmed;
}

// A full lower-case sha or nothing: the value is compared with AMI tags and
// logged, and anything shorter or looser would make "equal" mean less.
function commitString(value: unknown): string | null {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value) ? value : null;
}

// A plausible commit date: parseable, after the project existed, not in the future by more than a day.
function commitDate(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const t = Date.parse(value);
  if (Number.isNaN(t) || t < Date.UTC(2024, 0, 1) || t > Date.now() + 86_400_000) return null;
  return new Date(t);
}

function optionalString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
