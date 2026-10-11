import type { Box, Project } from '../api.js';
import { CliError, usage } from '../errors.js';

/** The fields of /boxes and /projects that connecting needs; older orchestrators may omit them. */
export interface ConnectBox extends Box {
  ec2InstanceId?: string | null;
  region?: string | null;
  hostUnixUser?: string | null;
}

export interface ConnectProject extends Project {
  directory?: string;
  sessions?: { agent: string; ctrl: string } | null;
}

export interface Ref {
  box: string;
  project: string | null;
}

/** `devbox` is a box and `devbox/fix` a project on it; the slash decides (PRD "Addressing"). */
export function parseRef(text: string | undefined): Ref {
  if (!text) throw usage('Name a box (`devbox`) or a project (`devbox/my-project`)');
  const parts = text.split('/');
  if (parts.length > 2 || parts.some(p => p === '')) {
    throw usage(`\`${text}\` is neither a box (\`devbox\`) nor a project (\`devbox/my-project\`)`);
  }
  return { box: parts[0], project: parts[1] ?? null };
}

export function pickBox(boxes: ConnectBox[], name: string): ConnectBox {
  const box = boxes.find(b => b.name === name) ?? boxes.find(b => b.id === name);
  if (box) return box;
  const names = boxes.filter(b => b.addressable).map(b => b.name);
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
