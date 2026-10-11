import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * The orchestrator side of `termag doctor` for the fake orchestrator: the
 * credential routes of backend routes/cliCredentials.ts.
 */
export interface FakeDoctorState {
  /** Registered key lines (added in the web UI; tests push them directly). */
  sshKeys: string[];
  github: { available: boolean; connected: { label: string; updatedAt: string } | null };
  claudeGateway: { available: boolean; enabled: boolean };
  /** Every token PUT /github received, to check what the CLI sent. */
  githubTokens: string[];
}

export function newDoctorState(): FakeDoctorState {
  return {
    sshKeys: [],
    github: { available: true, connected: null },
    claudeGateway: { available: true, enabled: true },
    githubTokens: [],
  };
}

const fingerprint = (line: string) =>
  'SHA256:' + createHash('sha256').update(Buffer.from(line.split(' ')[1], 'base64')).digest('base64').replace(/=+$/, '');

const keyView = (line: string) => ({
  id: fingerprint(line), type: line.split(' ')[0], fingerprint: fingerprint(line), comment: line.split(' ')[2] ?? '',
});

function send(res: ServerResponse, status: number, body: unknown): true {
  res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
  return true;
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

/** Answers `route` (`METHOD /path`) if it is a doctor route; false otherwise. */
export async function handleDoctor(
  state: FakeDoctorState, route: string, req: IncomingMessage, isDevice: boolean, res: ServerResponse,
): Promise<boolean> {
  if (route === 'GET /credentials') {
    return send(res, 200, { github: state.github, claudeGateway: state.claudeGateway, sshKeys: state.sshKeys.map(keyView) });
  }
  // Adding an SSH key is web-only, so POST /ssh-keys falls through to the 404 like the real API.
  if (route !== 'PUT /github') return false;
  if (!isDevice) {
    return send(res, 403, { error: 'A box\'s own credentials cannot change your GitHub token', code: 'box_credential' });
  }
  const input = await body(req);
  if (!state.github.available) return send(res, 503, { error: 'The credential store is not configured on this orchestrator.' });
  state.githubTokens.push(input.token as string);
  state.github.connected = { label: '@alice-gh', updatedAt: '2026-10-05T00:00:00.000Z' };
  return send(res, 200, { label: '@alice-gh' });
}
