import type { Box, Project } from '../api.js';
import { CliError, usage } from '../errors.js';

/** The fields of /boxes and /projects that connecting needs; older orchestrators may omit them. */
export interface ConnectBox extends Box {
  ec2InstanceId?: string | null;
  region?: string | null;
  hostUnixUser?: string | null;
  /** 'ask' for a box made only for `termag ask` (`--for-ask`). */
  createdFor?: string | null;
}

export interface ConnectProject extends Project {
  directory?: string;
  sessions?: { agent: string; ctrl: string } | null;
  /** 'ask' for a project made only for `termag ask` (`--for-ask`). */
  createdFor?: string | null;
}

export interface Ref {
  /** Null: the caller's only box (`parseRef`'s `defaultBox`). */
  box: string | null;
  project: string | null;
}

/**
 * `devbox` is a box and `devbox/fix` a project on it; the slash decides (PRD "Addressing").
 * With `defaultBox`, no text at all means the caller's only box, which `pickBox` finds.
 */
export function parseRef(text: string | undefined, opts: { defaultBox?: boolean } = {}): Ref {
  if (!text && opts.defaultBox) return { box: null, project: null };
  if (!text) throw usage('Name a box (`devbox`) or a project (`devbox/my-project`)');
  const parts = text.split('/');
  if (parts.length > 2 || parts.some(p => p === '')) {
    throw usage(`\`${text}\` is neither a box (\`devbox\`) nor a project (\`devbox/my-project\`)`);
  }
  return { box: parts[0], project: parts[1] ?? null };
}

/** A box by name or id; with no name, the only box, since with several the caller must say which. */
export function pickBox(boxes: ConnectBox[], name: string | null): ConnectBox {
  const names = boxes.filter(b => b.addressable).map(b => b.name);
  if (name === null) {
    if (boxes.length === 1) return boxes[0];
    if (boxes.length === 0) throw new CliError('not_found', 'You have no boxes; create one with `termag box create <name>`');
    throw usage(`You have ${boxes.length} boxes${names.length ? ` (${names.join(', ')})` : ''}; name the one to use`);
  }
  const box = boxes.find(b => b.name === name) ?? boxes.find(b => b.id === name);
  if (box) return box;
  throw new CliError('not_found', `No box named "${name}"${names.length ? `; your boxes: ${names.join(', ')}` : '; you have no boxes'}`);
}

export function pickProject(projects: ConnectProject[], box: ConnectBox, name: string): ConnectProject {
  const onBox = projects.filter(p => p.box.id === box.id);
  const project = onBox.find(p => p.name === name);
  if (project) return project;
  const names = onBox.map(p => p.name);
  throw new CliError('not_found',
    `No project "${name}" on ${box.name}${names.length ? `; its projects: ${names.join(', ')}` : '; it has no projects'}`);
}

/** The SSM target for a box, or why there isn't one right now. */
export function ssmTarget(box: ConnectBox, defaultRegion: string): { instanceId: string; region: string } {
  if (box.kind !== 'ec2' || !box.ec2InstanceId) {
    throw new CliError('failed', `${box.name} is not an EC2 box, so termag can't reach it over SSM`);
  }
  switch (box.state) {
    case 'running':
    case 'unknown':
      break;
    case 'stopped':
      throw new CliError('failed', `${box.name} is stopped; start it (\`termag box start ${box.name}\` or the web UI) and try again`);
    case 'stopping':
      throw new CliError('failed', `${box.name} is stopping`);
    case 'hibernated':
      throw new CliError('failed',
        `${box.name} is hibernated; resume it (\`termag box start ${box.name}\` or the web UI), which keeps its sessions, and try again`);
    case 'hibernating':
      throw new CliError('failed',
        `${box.name} is hibernating; once it is hibernated, resume it with \`termag box start ${box.name}\` and try again`);
    case 'failed':
      throw new CliError('failed', `${box.name} failed to come up${box.error ? `: ${box.error}` : ''}`);
    default:
      throw new CliError('failed', `${box.name} is ${box.state}; try again once it is running`);
  }
  return { instanceId: box.ec2InstanceId, region: box.region || defaultRegion };
}

export type WakeAction = 'connect' | 'wait' | 'start' | 'wait-then-start' | 'refuse';

/**
 * What `termag ssh-proxy --wake` does with a box in each state before it
 * connects. The orchestrator starts only a box that has finished parking, so
 * one on its way down is waited for first. Any other state is refused, with
 * ssmTarget's reason.
 */
const WAKE_ACTIONS = new Map<string, WakeAction>([
  ['running', 'connect'],
  ['unknown', 'connect'],
  ['starting', 'wait'],
  ['stopped', 'start'],
  ['hibernated', 'start'],
  ['stopping', 'wait-then-start'],
  ['hibernating', 'wait-then-start'],
]);

export function wakeAction(state: string): WakeAction {
  return WAKE_ACTIONS.get(state) ?? 'refuse';
}

/** `termag-<box>`, the host name ssh and the ssh-config entry use. */
export const HOST_PREFIX = 'termag-';

export function aliasFor(box: ConnectBox): string {
  return `${HOST_PREFIX}${box.name}`;
}

export function boxFromAlias(alias: string): string {
  if (!alias.startsWith(HOST_PREFIX) || alias.length === HOST_PREFIX.length) {
    throw usage(`\`${alias}\` is not a termag host; they are named ${HOST_PREFIX}<box>`);
  }
  return alias.slice(HOST_PREFIX.length);
}
