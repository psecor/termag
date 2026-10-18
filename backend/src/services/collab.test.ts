import { describe, expect, it } from 'vitest';
import {
  ACTIONS,
  LIMITS,
  cardBlocks,
  cardHeader,
  collabNudgeDecision,
  collabNudgeLine,
  draftSecrets,
  editValues,
  evidenceText,
  parseDraft,
  previewBlocks,
  trimEvidence,
  type CardInput,
} from './collab';

const card = (over: Partial<CardInput> = {}): CardInput => ({
  id: 'cr1', kind: 'help', ask: 'Status tests fail on the box', context: ['Started after #420'], tried: 'Reran with -t',
  helpWanted: 'A guess at the cause', evidence: 'Error: boom', links: ['https://github.com/o/r/pull/1'], state: 'open',
  origin: 'agent', senderSlackId: 'U123ABC', senderName: 'Pat', where: { label: 'termag · slack-app', link: 'https://t/termag/?project=p1&ws=slack-app' },
  cc: [], ...over,
});

const texts = (blocks: unknown[]) => JSON.stringify(blocks);

describe('parseDraft', () => {
  it('accepts a minimal FYI and defaults to the project channel', () => {
    const r = parseDraft({ kind: 'fyi', ask: 'Check out the new dashboard' });
    expect(r).toEqual({ ok: true, value: expect.objectContaining({ kind: 'fyi', ask: 'Check out the new dashboard', context: [], links: [], to: { channel: 'project' } }) });
  });

  it('rejects unknown kinds, missing or multi-line asks, and over-long asks', () => {
    expect(parseDraft({ kind: 'decision', ask: 'x' }).ok).toBe(false);
    expect(parseDraft({ kind: 'fyi' }).ok).toBe(false);
    expect(parseDraft({ kind: 'fyi', ask: 'a\nb' }).ok).toBe(false);
    expect(parseDraft({ kind: 'fyi', ask: 'x'.repeat(LIMITS.ask + 1) }).ok).toBe(false);
  });

  it('takes context as a list or as lines, strips bullet marks, and caps it', () => {
    const r = parseDraft({ kind: 'fyi', ask: 'x', context: '- one\n• two\n\n* three' });
    expect(r.ok && r.value.context).toEqual(['one', 'two', 'three']);
    expect(parseDraft({ kind: 'fyi', ask: 'x', context: Array(LIMITS.contextItems + 1).fill('c') }).ok).toBe(false);
    expect(parseDraft({ kind: 'fyi', ask: 'x', context: ['y'.repeat(LIMITS.contextItem + 1)] }).ok).toBe(false);
  });

  it('keeps tried and helpWanted for help only', () => {
    expect(parseDraft({ kind: 'fyi', ask: 'x', tried: 'stuff' }).ok).toBe(false);
    const r = parseDraft({ kind: 'help', ask: 'x', tried: 'stuff', helpWanted: 'eyes' });
    expect(r.ok && [r.value.tried, r.value.helpWanted]).toEqual(['stuff', 'eyes']);
  });

  it('allows https links only', () => {
    expect(parseDraft({ kind: 'fyi', ask: 'x', links: ['http://x.y'] }).ok).toBe(false);
    expect(parseDraft({ kind: 'fyi', ask: 'x', links: ['https://x.y/z'] }).ok).toBe(true);
  });

  it('validates destinations: project, a channel id, or a DM to exactly one person', () => {
    expect(parseDraft({ kind: 'fyi', ask: 'x', to: { channel: '#general' } }).ok).toBe(false);
    expect(parseDraft({ kind: 'fyi', ask: 'x', to: { channel: 'C0123ABCD' } }).ok).toBe(true);
    const dm = parseDraft({ kind: 'fyi', ask: 'x', to: { people: ['zane@example.com'] } });
    expect(dm.ok && dm.value.to).toEqual({ people: ['zane@example.com'] });
    expect(parseDraft({ kind: 'fyi', ask: 'x', to: { people: ['U1234567', 'U7654321'] } }).ok).toBe(false);
    const cc = parseDraft({ kind: 'fyi', ask: 'x', to: { channel: 'project', people: ['U1234567', 'U7654321'] } });
    expect(cc.ok).toBe(true);
    expect(parseDraft({ kind: 'fyi', ask: 'x', to: { people: ['@zane'] } }).ok).toBe(false);
  });

  it('trims evidence to the line cap and says so', () => {
    const r = parseDraft({ kind: 'help', ask: 'x', evidence: Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n') });
    expect(r.ok && r.value.evidence?.split('\n').length).toBe(LIMITS.evidenceLines + 1);
    expect(r.ok && r.value.evidence).toMatch(/… \(trimmed\)$/);
    expect(trimEvidence('short')).toBe('short');
  });

  it('keeps trimmed evidence within the cap, note included, so the Edit modal accepts it', () => {
    const long = trimEvidence('x'.repeat(LIMITS.evidenceChars + 500));
    expect(long.length).toBeLessThanOrEqual(LIMITS.evidenceChars);
    expect(long).toMatch(/… \(trimmed\)$/);
    const manyLongLines = trimEvidence(Array.from({ length: 40 }, () => 'y'.repeat(400)).join('\n'));
    expect(manyLongLines.length).toBeLessThanOrEqual(LIMITS.evidenceChars);
  });
});

describe('draftSecrets', () => {
  it('finds secret-shaped strings in any field', () => {
    expect(draftSecrets({ ask: 'x', context: [], links: [], evidence: 'token ' + ['xoxb', '123456789012', 'abcdefghij'].join('-') })).toEqual(['Slack token']);
    // Built at runtime so the fixture itself is not a secret-shaped literal (gitleaks).
    expect(draftSecrets({ ask: 'x', context: ['AKIA' + 'ABCDEFGHIJKLMNOP'], links: [] })).toEqual(['AWS access key id']);
    expect(draftSecrets({ ask: 'nothing here', context: ['fine'], links: [] })).toEqual([]);
  });
});

describe('cards', () => {
  it('leads with the kind and the ask, and marks resolved or withdrawn cards', () => {
    expect(cardHeader(card())).toBe('🆘 Help wanted: Status tests fail on the box');
    expect(cardHeader(card({ kind: 'fyi' }))).toBe('📣 FYI: Status tests fail on the box');
    expect(cardHeader(card({ state: 'resolved' }))).toBe('✅ Resolved · Status tests fail on the box');
    expect(cardHeader(card({ ask: 'y'.repeat(300) })).length).toBe(150);
  });

  it('says who it is from, where, and that an agent drafted it', () => {
    const t = texts(cardBlocks(card(), { interactive: true }).blocks);
    expect(t).toContain('From <@U123ABC> · <https://t/termag/?project=p1&ws=slack-app|termag · slack-app> · drafted with Claude in termag');
    expect(texts(cardBlocks(card({ origin: 'web' }), { interactive: true }).blocks)).toContain('sent from termag');
  });

  it('escapes Slack mrkdwn in user text', () => {
    const t = texts(cardBlocks(card({ context: ['a <b> & c'] }), { interactive: false }).blocks);
    expect(t).toContain('a &lt;b&gt; &amp; c');
  });

  it('has Reply only while open, and no buttons at all in a preview', () => {
    const open = texts(cardBlocks(card(), { interactive: true }).blocks);
    expect(open).toContain(ACTIONS.reply);
    expect(open).toContain(ACTIONS.fullContext);
    expect(texts(cardBlocks(card({ state: 'resolved' }), { interactive: true }).blocks)).not.toContain(ACTIONS.reply);
    expect(texts(cardBlocks(card(), { interactive: false }).blocks)).not.toContain('"actions"');
  });

  it('shows the help sections only for help, and cc only when given', () => {
    expect(texts(cardBlocks(card(), { interactive: false }).blocks)).toContain('*What I tried*');
    expect(texts(cardBlocks(card({ kind: 'fyi', tried: null, helpWanted: null }), { interactive: false }).blocks)).not.toContain('What I tried');
    expect(texts(cardBlocks(card({ cc: ['U999AAA'] }), { interactive: false }).blocks)).toContain('cc <@U999AAA>');
  });

  it('previews with Send, Edit and Cancel and names the destination', () => {
    const p = previewBlocks(card(), 'a DM to <@U999AAA>');
    const t = texts(p.blocks);
    expect(t).toContain('Nothing is posted until you press Send. It goes to a DM to <@U999AAA>.');
    for (const a of [ACTIONS.send, ACTIONS.edit, ACTIONS.cancel]) expect(t).toContain(a);
  });

  it('keeps evidence in a code block that cannot be closed early', () => {
    expect(evidenceText('a ``` b <x>')).toBe("*Evidence*\n```a ''' b &lt;x&gt;```");
  });
});

describe('editValues', () => {
  it('reads the edit modal back as draft fields', () => {
    const v = editValues({ ask: { v: { value: 'New ask' } }, context: { v: { value: 'a\nb' } }, evidence: { v: { value: null } } });
    expect(v).toEqual({ ask: 'New ask', context: ['a', 'b'], tried: undefined, helpWanted: undefined, evidence: undefined });
  });
});

describe('the reply nudge', () => {
  it('is fixed text with the request id and never the reply', () => {
    expect(collabNudgeLine('cr1', 1)).toBe('[termag] a new reply to your Slack request cr1. Call slack_inbox (metaterm MCP server) to read it.');
    expect(collabNudgeLine('cr1', 3)).toBe('[termag] 3 new replies to your Slack request cr1. Call slack_inbox (metaterm MCP server) to read them.');
  });

  const now = Date.parse('2026-10-17T12:00:00Z');
  const base = { fromRole: 'agent', fromSession: 'me-proj-agent', replyAt: new Date(now - 1000), sessionStatus: 'idle', sessionConnected: true, humanLastTyped: null, now };

  it('nudges only an idle, connected agent pane its person is not typing in', () => {
    expect(collabNudgeDecision(base)).toBe('nudge');
    expect(collabNudgeDecision({ ...base, sessionStatus: 'working' })).toBe('wait');
    expect(collabNudgeDecision({ ...base, sessionStatus: 'waiting' })).toBe('wait');
    expect(collabNudgeDecision({ ...base, sessionConnected: false })).toBe('wait');
    expect(collabNudgeDecision({ ...base, humanLastTyped: now - 10_000 })).toBe('wait');
    expect(collabNudgeDecision({ ...base, fromRole: 'ctrl' })).toBe('skip');
    expect(collabNudgeDecision({ ...base, replyAt: new Date(now - 2 * 24 * 3600_000) })).toBe('skip');
  });
});
