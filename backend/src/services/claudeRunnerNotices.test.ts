import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GITHUB_ABSENT_NOTICE, GITHUB_NOTICE_WINDOW_MS, NO_SLACK_USER_MEMO_MS, REFUSAL_NOTICE_WINDOW_MS,
  noticeForGithubAbsent, noticeForRefusal, notifyGithubAbsent, notifyOwner, notifyRefusal, resetSlackUserMemo, termagUrlFromEnv,
} from './claudeRunnerNotices';
import { REFUSAL_CODES, type RefusalCode } from './claudeRunnerSpawn';
import { prisma } from '../db';
import { boolVariation } from './featureFlags';

vi.mock('../db', () => {
  const prisma: Record<string, unknown> = {
    claudeSessionNotice: { findFirst: vi.fn(), create: vi.fn(), delete: vi.fn(async () => ({})) },
    user: { update: vi.fn(async () => ({})) },
    $executeRaw: vi.fn(async () => 0),
  };
  // The interactive transaction runs its body against the same fakes.
  prisma.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma));
  return { prisma };
});
vi.mock('./featureFlags', () => ({ boolVariation: vi.fn(async () => true) }));
vi.mock('../slack/app', () => ({ getSlackApp: () => null }));

const input = { sessionId: 'cse_01ABC', text: 'the reason', boxName: 'claude-20261009', termagUrl: 'https://termag.example.test/termag' };
const owner = { id: 'u1', googleEmail: 'ada@example.com', displayName: 'Ada', unixUsername: 'ada', defaultAgentProvider: 'claude', slackUserId: null as string | null };

describe('noticeForRefusal', () => {
  it('has a DM for every code except the hook giving up and the agent failures', () => {
    const silent: RefusalCode[] = ['hook-gave-up', 'agent-list-failed', 'agent-launch-failed'];
    for (const code of REFUSAL_CODES) {
      const text = noticeForRefusal(code, input);
      if (silent.includes(code)) expect(text, code).toBeNull();
      else expect(text, code).toMatch(/Claude Code cloud session/);
    }
  });

  it('links the session, and termag only where the fix is there, and names the access step for a fix in termag', () => {
    const github = noticeForRefusal('github', input)!;
    expect(github).toContain('https://claude.ai/code/session_01ABC');
    expect(github).toContain('https://termag.example.test/termag/settings');
    expect(github).toContain('ask whoever runs your termag for access');
    expect(github).toContain('Connect GitHub');
    // The "termag is doing this" notices carry the session link only (Bugbot on #289).
    for (const code of ['box-claimed', 'box-starting', 'box-provisioning'] as const) {
      const doing = noticeForRefusal(code, input)!;
      expect(doing, code).toContain('claude-20261009');
      expect(doing, code).toContain('https://claude.ai/code/session_01ABC');
      expect(doing, code).not.toContain('/settings');
      expect(doing, code).not.toContain('for access');
    }
    // Without a termag URL the link is left out, the rest stands.
    expect(noticeForRefusal('no-box', { ...input, termagUrl: null })).not.toContain('/settings');
    expect(noticeForRefusal('no-box', { ...input, termagUrl: null })).toContain('ask whoever runs your termag for access');
    // Codes whose text is termag's own words carry it.
    expect(noticeForRefusal('box-hold', input)).toContain('the reason');
  });

  it('never carries the email', () => {
    for (const code of REFUSAL_CODES) expect(noticeForRefusal(code, { ...input, text: 'x' }) ?? '').not.toMatch(/@/);
  });
});

describe('noticeForGithubAbsent', () => {
  it('says what works, what needs GitHub, and where to connect it', () => {
    const text = noticeForGithubAbsent(input);
    expect(text).toContain('Anthropic-managed git');
    expect(text).toContain('`gh`');
    expect(text).toContain('ask whoever runs your termag for access');
    expect(text).toContain('https://termag.example.test/termag/settings');
    expect(text).toContain('claude-20261009');
  });
});

describe('termagUrlFromEnv', () => {
  it('joins FRONTEND_URL and BASE_PATH, or knows nothing', () => {
    expect(termagUrlFromEnv({ FRONTEND_URL: 'https://t.example.test/', BASE_PATH: '/termag' })).toBe('https://t.example.test/termag');
    expect(termagUrlFromEnv({ FRONTEND_URL: 'https://t.example.test' })).toBe('https://t.example.test');
    expect(termagUrlFromEnv({})).toBeNull();
    expect(termagUrlFromEnv({ FRONTEND_URL: 'localhost:3040' })).toBeNull();
  });
});

describe('notifyOwner', () => {
  const posted: Array<{ channel: string; text: string }> = [];
  const client = {
    users: { lookupByEmail: vi.fn(async () => ({ user: { id: 'U123' } })) },
    chat: { postMessage: vi.fn(async (args: { channel: string; text: string }) => { posted.push(args); }) },
  };
  beforeEach(() => {
    posted.length = 0;
    resetSlackUserMemo();
    vi.mocked(prisma.claudeSessionNotice.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.claudeSessionNotice.create).mockResolvedValue({ id: 'n-new' } as never);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.clearAllMocks());

  it('looks the Slack user up by email once, remembers it, records the notice before posting, and posts', async () => {
    const sent = await notifyOwner(owner, 'cse_01ABC', 'no-box', 'hello', { windowMs: REFUSAL_NOTICE_WINDOW_MS, client });
    expect(sent).toBe(true);
    expect(client.users.lookupByEmail).toHaveBeenCalledWith({ email: 'ada@example.com' });
    expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: 'u1' }, data: { slackUserId: 'U123' } });
    expect(posted).toEqual([{ channel: 'U123', text: 'hello' }]);
    expect(prisma.claudeSessionNotice.create).toHaveBeenCalledWith({ data: { userId: 'u1', sessionId: 'cse_01ABC', code: 'no-box', at: expect.any(Date) } });
    const recordedAt = vi.mocked(prisma.claudeSessionNotice.create).mock.invocationCallOrder[0];
    const postedAt = client.chat.postMessage.mock.invocationCallOrder[0];
    expect(recordedAt).toBeLessThan(postedAt);
    // A known Slack id skips the lookup.
    await notifyOwner({ ...owner, slackUserId: 'U999' }, 'cse_02', 'no-box', 'again', { windowMs: REFUSAL_NOTICE_WINDOW_MS, client });
    expect(client.users.lookupByEmail).toHaveBeenCalledTimes(1);
    expect(posted[1]).toEqual({ channel: 'U999', text: 'again' });
  });

  it('is silent when a notice with that key stands for the session, and the window is the one asked for', async () => {
    vi.mocked(prisma.claudeSessionNotice.findFirst).mockResolvedValue({ id: 'n1' } as never);
    const now = new Date('2026-10-09T12:00:00Z');
    expect(await notifyOwner(owner, 'cse_01ABC', 'no-box', 'hello', { windowMs: REFUSAL_NOTICE_WINDOW_MS, client, now })).toBe(false);
    expect(posted).toEqual([]);
    expect(prisma.claudeSessionNotice.findFirst).toHaveBeenCalledWith({
      where: { userId: 'u1', code: 'no-box', at: { gte: new Date(now.getTime() - REFUSAL_NOTICE_WINDOW_MS) }, sessionId: 'cse_01ABC' },
      select: { id: true },
    });
  });

  it('dedupes the GitHub reminder per owner, across sessions, for a week', async () => {
    const now = new Date('2026-10-09T12:00:00Z');
    await notifyGithubAbsent({ ...owner, slackUserId: 'U1' }, 'cse_01ABC', 'claude-20261009', { termagUrl: 'https://t.example.test/termag', client });
    expect(posted[0].text).toContain('Anthropic-managed git');
    expect(prisma.claudeSessionNotice.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ code: GITHUB_ABSENT_NOTICE }),
    }));
    const where = vi.mocked(prisma.claudeSessionNotice.findFirst).mock.calls[0][0]!.where as Record<string, unknown>;
    expect(where).not.toHaveProperty('sessionId');
    expect((where.at as { gte: Date }).gte.getTime()).toBeGreaterThan(now.getTime() - GITHUB_NOTICE_WINDOW_MS - 60_000);
  });

  it('posts once for two concurrent refusals of the same session and code (Devin on #289)', async () => {
    let created = false;
    vi.mocked(prisma.claudeSessionNotice.findFirst).mockImplementation((async () => (created ? { id: 'n1' } : null)) as never);
    vi.mocked(prisma.claudeSessionNotice.create).mockImplementation((async () => { created = true; return { id: 'n1' }; }) as never);
    const results = await Promise.all([
      notifyOwner({ ...owner, slackUserId: 'U1' }, 'cse_01ABC', 'no-box', 'hello', { windowMs: REFUSAL_NOTICE_WINDOW_MS, client }),
      notifyOwner({ ...owner, slackUserId: 'U1' }, 'cse_01ABC', 'no-box', 'hello', { windowMs: REFUSAL_NOTICE_WINDOW_MS, client }),
    ]);
    expect(results.sort()).toEqual([false, true]);
    expect(posted).toHaveLength(1);
  });

  it('records under a Postgres advisory lock on the (owner, key), and stands down when another process recorded first (Bugbot on #289)', async () => {
    // The happy path: the lock is taken, then the lookup and the record run under it.
    await notifyOwner({ ...owner, slackUserId: 'U1' }, 'cse_01ABC', 'no-box', 'hello', { windowMs: REFUSAL_NOTICE_WINDOW_MS, client });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    const [strings, ...values] = vi.mocked(prisma.$executeRaw).mock.calls[0] as unknown as [TemplateStringsArray, ...unknown[]];
    expect(strings.join('?')).toContain('pg_advisory_xact_lock(hashtext(?))');
    expect(values).toEqual(['claude-runner:notice:u1:no-box']);
    expect(vi.mocked(prisma.$executeRaw).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(prisma.claudeSessionNotice.create).mock.invocationCallOrder[0]);
    expect(posted).toHaveLength(1);

    // Another backend process recorded the same notice between this one's first look and its lock.
    vi.clearAllMocks();
    const tx = { claudeSessionNotice: { findFirst: vi.fn(async () => ({ id: 'n-other' })), create: vi.fn() }, $executeRaw: vi.fn(async () => 0) };
    vi.mocked(prisma.$transaction).mockImplementationOnce((async (fn: (t: unknown) => unknown) => fn(tx)) as never);
    const sent = await notifyOwner({ ...owner, slackUserId: 'U1' }, 'cse_01ABC', 'no-box', 'hello', { windowMs: REFUSAL_NOTICE_WINDOW_MS, client });
    expect(sent).toBe(false);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(tx.claudeSessionNotice.create).not.toHaveBeenCalled();
    expect(prisma.claudeSessionNotice.create).not.toHaveBeenCalled();
    expect(posted).toHaveLength(1);
  });

  it('reads the flag on the placeholder key for an auto-created owner but records the notice against the row (Devin on #289)', async () => {
    const fresh = { ...owner, id: 'ckrow', googleId: 'claude:user_01HXYZ', slackUserId: 'U1' };
    await notifyOwner(fresh, 'cse_01ABC', 'no-box', 'hello', { windowMs: REFUSAL_NOTICE_WINDOW_MS, client });
    expect(vi.mocked(boolVariation).mock.calls[0][1]).toMatchObject({ id: 'claude:user_01HXYZ' });
    expect(prisma.claudeSessionNotice.create).toHaveBeenCalledWith({ data: expect.objectContaining({ userId: 'ckrow' }) });
  });

  it('treats Slack\'s users_not_found rejection as the missing-user case and remembers it for a while (Bugbot on #289)', async () => {
    const now = new Date('2026-10-09T12:00:00Z');
    client.users.lookupByEmail.mockRejectedValueOnce(Object.assign(new Error('An API error occurred: users_not_found'), { data: { ok: false, error: 'users_not_found' } }));
    expect(await notifyOwner(owner, 'cse_01ABC', 'no-box', 'hello', { windowMs: REFUSAL_NOTICE_WINDOW_MS, client, now })).toBe(false);
    expect(vi.mocked(console.log).mock.calls.map(c => String(c[0]))).toContain('[CLAUDE-RUNNER] notice no-box for ada not sent: no Slack user for their email');
    expect(console.error).not.toHaveBeenCalled();
    expect(prisma.claudeSessionNotice.create).not.toHaveBeenCalled();
    // The next refusal in the window does not ask Slack again; past it, it does.
    expect(await notifyOwner(owner, 'cse_01ABC', 'boxes-full', 'hello', { windowMs: REFUSAL_NOTICE_WINDOW_MS, client, now: new Date(now.getTime() + 60_000) })).toBe(false);
    expect(client.users.lookupByEmail).toHaveBeenCalledTimes(1);
    expect(await notifyOwner(owner, 'cse_01ABC', 'boxes-full', 'hello', { windowMs: REFUSAL_NOTICE_WINDOW_MS, client, now: new Date(now.getTime() + NO_SLACK_USER_MEMO_MS + 1) })).toBe(true);
    expect(client.users.lookupByEmail).toHaveBeenCalledTimes(2);
    // Any other Slack error is still a failure line.
    client.users.lookupByEmail.mockRejectedValueOnce(Object.assign(new Error('ratelimited'), { data: { ok: false, error: 'ratelimited' } }));
    expect(await notifyOwner({ ...owner, id: 'u2' }, 'cse_02', 'no-box', 'hello', { windowMs: REFUSAL_NOTICE_WINDOW_MS, client })).toBe(false);
    expect(vi.mocked(console.error).mock.calls.map(c => String(c[0]))).toContain('[CLAUDE-RUNNER] notice no-box for ada failed:');
  });

  it('sends nothing with the flag off, without a Slack client, or for a code with no notice, and never throws', async () => {
    vi.mocked(boolVariation).mockResolvedValueOnce(false);
    expect(await notifyOwner(owner, 'cse_01ABC', 'no-box', 'hello', { windowMs: 1, client })).toBe(false);
    expect(await notifyOwner(owner, 'cse_01ABC', 'no-box', 'hello', { windowMs: 1, client: null })).toBe(false);
    expect(await notifyRefusal(owner, 'cse_01ABC', 'hook-gave-up', 'x')).toBe(false);
    expect(posted).toEqual([]);
    client.chat.postMessage.mockRejectedValueOnce(new Error('channel_not_found'));
    expect(await notifyOwner(owner, 'cse_01ABC', 'boxes-full', 'hello', { windowMs: 1, client })).toBe(false);
    expect(vi.mocked(console.error).mock.calls.map(c => String(c[0]))).toContain('[CLAUDE-RUNNER] notice boxes-full for ada failed:');
    // A post Slack refused takes its record back, so the next refusal tries again (Devin on #289).
    expect(prisma.claudeSessionNotice.delete).toHaveBeenCalledWith({ where: { id: 'n-new' } });
    client.users.lookupByEmail.mockResolvedValueOnce({ user: undefined } as never);
    expect(await notifyOwner({ ...owner, id: 'u-miss' }, 'cse_01ABC', 'no-box', 'hello', { windowMs: 1, client })).toBe(false);
    expect(vi.mocked(console.log).mock.calls.map(c => String(c[0]))).toContain('[CLAUDE-RUNNER] notice no-box for ada not sent: no Slack user for their email');
    // The default client is the Slack app's, absent here.
    expect(await notifyRefusal(owner, 'cse_01ABC', 'no-box', 'x')).toBe(false);
  });
});
