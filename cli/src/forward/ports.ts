import { usage } from '../errors.js';

/** One forward: `port` on the box, reached at `local` on this machine's loopback. */
export interface ForwardPort {
  port: number;
  local: number;
  /** What notices call it, e.g. `webapp-api`. Default: `<box>:<port>`. */
  name?: string;
}

/** Below this a local listener would need root, and would shadow a system service. */
export const MIN_LOCAL_PORT = 1024;

function portNumber(text: string, what: string, whole: string): number {
  const n = /^\d{1,5}$/.test(text) ? Number(text) : NaN;
  if (!(n >= 1 && n <= 65535)) throw usage(`\`${whole}\`: ${what} must be a number from 1 to 65535`);
  return n;
}

/** `<port>[:<local>]`: the box's port first, then the local one (default: the same). */
export function parsePortSpec(text: string): ForwardPort {
  const [box, local, extra] = text.split(':');
  if (extra !== undefined || box === '' || local === '') {
    throw usage(`\`${text}\` is not <port>[:<local>], e.g. 3000 or 3000:3001`);
  }
  const port = portNumber(box, 'the box port', text);
  const localPort = local === undefined ? port : portNumber(local, 'the local port', text);
  if (localPort < MIN_LOCAL_PORT) {
    const suggestion = port + 8000 <= 65535 ? `; e.g. ${port}:${port + 8000}` : '';
    throw usage(`\`${text}\`: local port ${localPort} is below ${MIN_LOCAL_PORT}; pick a local port of ${MIN_LOCAL_PORT} or more${suggestion}`);
  }
  return { port, local: localPort };
}

/** Every spec, refusing two forwards on one local port. */
export function parsePortSpecs(texts: string[]): ForwardPort[] {
  const ports = texts.map(parsePortSpec);
  const seen = new Set<number>();
  for (const p of ports) {
    if (seen.has(p.local)) throw usage(`Local port ${p.local} is named twice; each forward needs its own local port`);
    seen.add(p.local);
  }
  return ports;
}
