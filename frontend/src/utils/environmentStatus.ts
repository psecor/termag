// How a project's environment steps read in the UIs:
// one badge for where the chain is, with setup's time once it
// has one, and a dot per port for its health. From Project.environmentStatus,
// the box's last report (backend services/projectEnvironment.ts).
import type { EnvironmentStatus } from '../types';

export type EnvironmentPhaseView = 'working' | 'up' | 'failed' | 'idle';

export interface EnvironmentView {
  label: string;
  phase: EnvironmentPhaseView;
  /** The longer story for a tooltip: each step with its time, the warnings. */
  title: string;
  ports: Array<{ name: string; port: number; healthy: boolean; url: string }>;
  /** The box will report again soon: worth polling for. */
  inFlight: boolean;
}

export function formatDuration(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

const IN_FLIGHT = new Set(['pending', 'setup', 'starting', 'waiting', 'seeding']);

/** null when there is nothing to show: no report, or a checkout with no environment file. */
export function environmentView(status: EnvironmentStatus | null | undefined, now = Date.now()): EnvironmentView | null {
  if (!status || status.state === 'none') return null;
  const setup = status.setup ?? { state: 'none' };
  const took = (p: { durationMs?: number }) => (typeof p.durationMs === 'number' ? formatDuration(p.durationMs) : null);
  const since = (p: { startedAt?: string }) => {
    const t = p.startedAt ? Date.parse(p.startedAt) : NaN;
    return Number.isFinite(t) && now > t ? ` ${formatDuration(now - t)}` : '';
  };
  const setupDone = setup.state === 'succeeded' && took(setup) ? `set up in ${took(setup)}` : null;
  let label: string;
  let phase: EnvironmentPhaseView;
  switch (status.state) {
    case 'pending': label = 'Environment starting'; phase = 'working'; break;
    case 'setup': label = `Setting up${since(setup)}`; phase = 'working'; break;
    case 'starting': label = setupDone ? `Starting the app · ${setupDone}` : 'Starting the app'; phase = 'working'; break;
    case 'waiting': label = setupDone ? `Waiting for health · ${setupDone}` : 'Waiting for health'; phase = 'working'; break;
    case 'seeding': label = 'Seeding'; phase = 'working'; break;
    case 'up': label = setupDone ? `App up · ${setupDone}` : 'App up'; phase = 'up'; break;
    case 'ready': label = setupDone ? `Ready · ${setupDone}` : 'Ready'; phase = 'up'; break;
    case 'stopped': label = 'App stopped'; phase = 'idle'; break;
    // A repository's own file, someone else's version of a shared environment, or a pointer that couldn't be pinned: the box keeps it, its owner runs it.
    case 'held': label = 'Held: read it, then termag-env up'; phase = 'idle'; break;
    default: {
      const failed = (['setup', 'run', 'seed'] as const).find(k => status[k]?.state === 'failed');
      label = failed === 'setup' ? `Setup failed${took(setup) ? ` after ${took(setup)}` : ''}` : failed === 'seed' ? 'Seed failed' : 'App failed to start';
      phase = 'failed';
    }
  }
  const lines = [`Environment file: ${status.file ?? '.termag/environment.json'}`];
  if (status.state === 'held') lines.push("Not started on its own: a repository's own environment file, an environment that points at one, a version of the environment someone else wrote, an automation's, or one on a box made for another project, runs only when you run it. termag-env show prints what it runs; termag-env up runs it.");
  for (const k of ['setup', 'run', 'seed'] as const) {
    const p = status[k];
    if (!p || p.state === 'none') continue;
    lines.push(`${k}: ${p.state}${took(p) ? `, ${took(p)}` : ''}${p.error ? ` (${p.error})` : ''}`);
  }
  if (status.secrets?.resolved?.length) lines.push(`secrets delivered: ${status.secrets.resolved.join(', ')}`);
  for (const w of status.warnings ?? []) lines.push(`warning: ${w}`);
  return {
    label,
    phase,
    title: lines.join('\n'),
    ports: (status.ports ?? []).map(p => ({ name: p.name, port: p.port, healthy: p.healthy, url: `http://${p.host === '::1' ? '[::1]' : 'localhost'}:${p.port}${p.path || '/'}` })),
    inFlight: IN_FLIGHT.has(status.state),
  };
}
