import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Ctx } from './context.js';
import { run } from './main.js';

/**
 * A stand-in for routes/spaceSlack.ts under /api/cli/v1/spaces: canned
 * answers, and every call recorded with its body, so the tests check what the
 * CLI sends and prints.
 */
interface Call { method: string; path: string; body: Record<string, unknown> | null }

let server: Server;
let host: string;
let calls: Call[];
let answers: Map<string, { status: number; body: unknown }>;
let home: string;
let out: string[];
let err: string[];
let interactive: boolean;
let answer: boolean;

const STATUS = {
  space: 'payments', enabled: true, status: 'active', runner: { userId: 'u1', email: 'me@example.com' },
  box: { kind: 'new', size: 'small' }, pendingRunner: null, caps: { channelsPerSpace: 5, allowPrivate: true },
  channels: [{
    channelId: 'C0FAKEGEN1', name: 'general', private: false, createdByTermag: false, linkedBy: { userId: 'u1', email: 'me@example.com' },
    linkedVia: 'cli', linkedAt: '2026-11-04T10:00:00.000Z', paused: false,
  }],
  you: { owner: true, runner: true }, slack: 'fake',
};
const PICKER = {
  channels: [
    { id: 'C0FAKEGEN1', name: 'general', private: false, termagIn: false, members: 14 },
    { id: 'C0FAKEPROJ', name: 'proj-demo-main', private: false, termagIn: true, members: 2, disabled: 'channel_workstream' },
  ],
  nextCursor: null,
};
const PREVIEW = { bystanders: 13, needsInvite: false, firstLink: true, channelName: 'general', isPrivate: false };
const LINKED = { channel: STATUS.channels[0], already: false, failedInvites: [] };

async function readBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : null;
}

beforeEach(async () => {
  calls = [];
  answers = new Map([
    ['GET /payments/slack', { status: 200, body: STATUS }],
    ['GET /slack/channels', { status: 200, body: PICKER }],
    ['POST /payments/slack/channels/preview', { status: 200, body: PREVIEW }],
    ['POST /payments/slack/channels', { status: 201, body: LINKED }],
    ['GET /payments/slack/channels/C0FAKEGEN1', { status: 200, body: { channel: STATUS.channels[0], threads: 2, canArchive: false } }],
    ['DELETE /payments/slack/channels/C0FAKEGEN1', { status: 200, body: { unlinked: 'C0FAKEGEN1', name: 'general', archived: false } }],
    ['POST /payments/slack/pause', { status: 200, body: { ...STATUS, status: 'paused' } }],
    ['DELETE /payments/slack', { status: 200, body: { disabled: true, unlinked: 1 } }],
    ['POST /payments/slack/runner', { status: 200, body: { ...STATUS, pendingRunner: { userId: 'u2', email: 'bob@example.com' } } }],
  ]);
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const path = url.pathname.replace(/^\/termag\/api\/cli\/v1\/spaces/, '');
    const body = await readBody(req);
    calls.push({ method: req.method!, path: `${path}${url.search}`, body });
    // An answer for the exact query wins over the path's.
    const a = answers.get(`${req.method} ${path}${url.search}`) ?? answers.get(`${req.method} ${path}`) ?? { status: 404, body: { error: 'Not found', code: 'not_found' } };
    res.writeHead(a.status, { 'Content-Type': 'application/json' }).end(JSON.stringify(a.body));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  host = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  home = mkdtempSync(join(tmpdir(), 'termag-space-slack-test-'));
  writeFileSync(join(home, 'agent.config.json'), JSON.stringify({ server_url: `${host.replace(/^http/, 'ws')}/termag/ws/agent`, token: 'tmag_box' }));
  out = [];
  err = [];
  interactive = false;
  answer = true;
});

afterEach(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  rmSync(home, { recursive: true, force: true });
});

function ctx(): Ctx {
  return {
    env: { TERMAG_AGENT_CONFIG: join(home, 'agent.config.json') },
    home,
    hostname: 'devbox',
    interactive,
    confirm: async () => answer,
    out: t => out.push(t),
    err: t => err.push(t),
    fetch: globalThis.fetch,
    openBrowser: () => { throw new Error('no browser in these tests'); },
    readFile: p => { try { return readFileSync(p, 'utf8'); } catch { return null; } },
    loginTimeoutMs: 1000,
  };
}

const termag = (...argv: string[]) => run(argv, ctx());
const writes = () => calls.filter(c => c.method !== 'GET' && !c.path.endsWith('/preview'));

describe('termag space slack', () => {
  it('prints the status, and --json gives the API\'s answer', async () => {
    expect(await termag('space', 'slack', 'status', 'payments')).toBe(0);
    expect(out.join('\n')).toMatch(/payments: Slack active, runner me@example.com on a new small box/);
    expect(out.join('\n')).toMatch(/#general\s+me@example.com\s+cli/);
    out = [];
    expect(await termag('space', 'slack', 'status', 'payments', '--json')).toBe(0);
    expect(JSON.parse(out.join(''))).toMatchObject({ enabled: true, channels: [{ channelId: 'C0FAKEGEN1' }] });
  });

  it('links a channel by #name: the picker finds its id, the preview is shown, and --yes commits', async () => {
    expect(await termag('space', 'slack', 'link', 'payments', '#general', '--runner-box', 'devbox', '--yes')).toBe(0);
    expect(calls.map(c => `${c.method} ${c.path}`)).toEqual([
      'GET /slack/channels?query=general',
      'POST /payments/slack/channels/preview',
      'POST /payments/slack/channels',
    ]);
    // Asked (or --yes): no precondition.
    expect(calls[2].body).toEqual({ channelId: 'C0FAKEGEN1', runner: { box: { existing: 'devbox' } } });
    expect(err.join('\n')).toMatch(/13 people in it are not members of payments/);
    expect(err.join('\n')).toMatch(/first channel/);
    expect(out.join('\n')).toMatch(/Linked #general to payments/);
  });

  it('refuses to commit without --yes when nobody can be asked, and stops when the answer is no', async () => {
    expect(await termag('space', 'slack', 'link', 'payments', 'C0FAKEGEN1')).toBe(2);
    expect(err.join('\n')).toMatch(/pass --yes/);
    expect(writes()).toEqual([]);
    interactive = true;
    answer = false;
    expect(await termag('space', 'slack', 'link', 'payments', 'C0FAKEGEN1')).toBe(1);
    expect(writes()).toEqual([]);
    answer = true;
    expect(await termag('space', 'slack', 'link', 'payments', '<#C0FAKEGEN1|general>')).toBe(0);
    expect(writes()).toHaveLength(1);
  });

  it('creates a channel with --create', async () => {
    expect(await termag('space', 'slack', 'link', 'payments', '--create', 'space-payments', '--private', '--invite-members', '--new-box', '--yes')).toBe(0);
    expect(writes()[0].body).toEqual({ create: { name: 'space-payments', private: true, inviteMembers: true }, runner: { box: { new: { size: 'small' } } } });
    expect(await termag('space', 'slack', 'link', 'payments', '#general', '--create', 'x')).toBe(2);
    expect(await termag('space', 'slack', 'link', 'payments', '#general', '--private')).toBe(2);
    expect(await termag('space', 'slack', 'link', 'payments', '#general', '--runner-box', 'a', '--new-box')).toBe(2);
  });

  it('stops before committing when termag must be invited first', async () => {
    answers.set('POST /payments/slack/channels/preview', { status: 200, body: { ...PREVIEW, needsInvite: true, isPrivate: true, channelName: null, bystanders: null } });
    expect(await termag('space', 'slack', 'link', 'payments', 'G0FAKESEC1', '--yes')).toBe(1);
    expect(err.join('\n')).toMatch(/\/invite @termag/);
    expect(writes()).toEqual([]);
  });

  it('says the server\'s refusal and exits non-zero', async () => {
    answers.set('POST /payments/slack/channels/preview', { status: 403, body: { error: 'Only an owner of payments can link or unlink its channels.', code: 'not_owner' } });
    expect(await termag('space', 'slack', 'link', 'payments', 'C0FAKEGEN1', '--yes')).toBe(1);
    expect(err.join('\n')).toMatch(/Only an owner of payments/);
    answers.set('GET /slack/channels', { status: 200, body: { channels: [], nextCursor: null } });
    expect(await termag('space', 'slack', 'link', 'payments', '#nope', '--yes')).toBe(3);
  });

  it('unlinks a linked channel by name, showing what stops answering; --archive only for one termag created', async () => {
    expect(await termag('space', 'slack', 'unlink', 'payments', '#general', '--yes')).toBe(0);
    expect(calls.map(c => `${c.method} ${c.path}`)).toEqual([
      'GET /payments/slack', 'GET /payments/slack/channels/C0FAKEGEN1', 'DELETE /payments/slack/channels/C0FAKEGEN1',
    ]);
    expect(out.join('\n')).toMatch(/Unlinked #general from payments/);
    calls = [];
    expect(await termag('space', 'slack', 'unlink', 'payments', 'C0FAKEGEN1', '--archive', '--yes')).toBe(2);
    expect(writes()).toEqual([]);
  });

  it('pauses, disables (asking first) and hands the runner over', async () => {
    expect(await termag('space', 'slack', 'pause', 'payments')).toBe(0);
    expect(out.join('\n')).toMatch(/Paused payments/);
    expect(await termag('space', 'slack', 'disable', 'payments')).toBe(2);
    expect(await termag('space', 'slack', 'disable', 'payments', '--yes')).toBe(0);
    expect(out.join('\n')).toMatch(/1 channel\(s\) unlinked/);
    expect(await termag('space', 'slack', 'runner', 'payments', 'offer', 'bob@example.com')).toBe(0);
    expect(calls.at(-1)!.body).toEqual({ offer: 'bob@example.com' });
    expect(out.join('\n')).toMatch(/Offered payments's runner to bob@example.com/);
    expect(await termag('space', 'slack', 'runner', 'payments', 'accept', '--runner-box', 'devbox')).toBe(0);
    expect(calls.at(-1)!.body).toEqual({ accept: true, box: { existing: 'devbox' } });
  });

  it('shows the preview on stderr with --json --yes, keeping stdout to the JSON answer', async () => {
    expect(await termag('space', 'slack', 'link', 'payments', 'C0FAKEGEN1', '--json', '--yes')).toBe(0);
    expect(err.join('\n')).toMatch(/13 people in it are not members of payments/);
    expect(JSON.parse(out.join(''))).toMatchObject({ channel: { channelId: 'C0FAKEGEN1' } });
  });

  it('shows what an unlink stops on stderr even with --yes', async () => {
    expect(await termag('space', 'slack', 'unlink', 'payments', 'C0FAKEGEN1', '--yes', '--json')).toBe(0);
    expect(err.join('\n')).toMatch(/2 termag threads there will stop answering/);
    expect(JSON.parse(out.join(''))).toMatchObject({ unlinked: 'C0FAKEGEN1' });
  });

  it('follows the picker\'s cursor to find a #name past its first page', async () => {
    const partial = Array.from({ length: 100 }, (_, i) => ({ id: `C0PAY${String(i).padStart(5, '0')}`, name: `pay-${i}`, private: false, termagIn: true, members: 1 }));
    answers.set('GET /slack/channels?query=pay', { status: 200, body: { channels: partial, nextCursor: 'c2' } });
    answers.set('GET /slack/channels?query=pay&cursor=c2', { status: 200, body: { channels: [{ id: 'C0PAYEXACT', name: 'pay', private: false, termagIn: true, members: 3 }], nextCursor: null } });
    expect(await termag('space', 'slack', 'link', 'payments', '#pay', '--yes')).toBe(0);
    expect(calls.find(c => c.method === 'POST' && c.path === '/payments/slack/channels')!.body).toEqual({ channelId: 'C0PAYEXACT' });
    // A name nowhere: it stops at the cursor's end and says not found.
    answers.set('GET /slack/channels?query=nope', { status: 200, body: { channels: [], nextCursor: null } });
    expect(await termag('space', 'slack', 'link', 'payments', '#nope', '--yes')).toBe(3);
  });

  it('says what a disable left linked, and exits 1 until it is finished', async () => {
    answers.set('DELETE /payments/slack', { status: 200, body: { disabled: true, unlinked: 1, remaining: 1 } });
    expect(await termag('space', 'slack', 'disable', 'payments', '--yes')).toBe(1);
    expect(err.join('\n')).toMatch(/1 channel\(s\) are still linked; run `termag space slack disable payments` again/);
    answers.set('GET /payments/slack', { status: 200, body: { ...STATUS, enabled: false, status: null } });
    out = [];
    expect(await termag('space', 'slack', 'status', 'payments')).toBe(0);
    expect(out.join('\n')).toMatch(/Slack is off for payments, but 1 channel\(s\) are still linked/);
    expect(out.join('\n')).toMatch(/#general\s+C0FAKEGEN1/);
  });

  it('says when a disable was overtaken by a new link, or left threads unfrozen', async () => {
    answers.set('DELETE /payments/slack', { status: 200, body: { disabled: false, unlinked: 0, remaining: 0, unfrozen: 0, reenabled: true } });
    expect(await termag('space', 'slack', 'disable', 'payments', '--yes')).toBe(1);
    expect(err.join('\n')).toMatch(/Slack is on again/);
    answers.set('DELETE /payments/slack', { status: 200, body: { disabled: true, unlinked: 1, remaining: 0, unfrozen: 1, reenabled: false } });
    expect(await termag('space', 'slack', 'disable', 'payments', '--yes')).toBe(1);
    expect(err.join('\n')).toMatch(/threads could not be frozen yet/);
  });

  it('for a channel already linked here, asks nothing but still commits (it repeats the freeze) and prints the commit\'s answer', async () => {
    answers.set('POST /payments/slack/channels/preview', { status: 200, body: { bystanders: null, needsInvite: false, firstLink: false, channelName: 'general', isPrivate: false, alreadyLinked: true } });
    answers.set('POST /payments/slack/channels', { status: 200, body: { ...LINKED, already: true } });
    expect(await termag('space', 'slack', 'link', 'payments', 'C0FAKEGEN1')).toBe(0);
    expect(out.join('\n')).toMatch(/#general was already linked to payments\./);
    expect(err.join('\n')).not.toMatch(/can't see who is in the channel|pass --yes/);
    expect(writes()).toHaveLength(1);
    // Unasked, so it commits only while the channel is still linked here.
    expect(writes()[0].body).toMatchObject({ channelId: 'C0FAKEGEN1', onlyIfLinked: true });
    out = [];
    expect(await termag('space', 'slack', 'link', 'payments', 'C0FAKEGEN1', '--json')).toBe(0);
    expect(JSON.parse(out.join(''))).toMatchObject({ already: true, channel: { channelId: 'C0FAKEGEN1' } });
  });

  it('lists the channels one can link', async () => {
    expect(await termag('space', 'slack', 'channels')).toBe(0);
    expect(out.join('\n')).toMatch(/#general\s+no\s+14\s+-\s+C0FAKEGEN1/);
    expect(out.join('\n')).toMatch(/can't: a workstream channel/);
  });

  it('is not `space link`, which stays `space url`', async () => {
    expect(await termag('space', 'slack', 'frobnicate', 'payments')).toBe(2);
    expect(await termag('space', 'slack')).toBe(2);
    expect(await termag('space', 'link')).toBe(2);
    expect(err.join('\n')).toMatch(/termag space url/);
  });
});
