/**
 * Slack collaboration, phase 1: the pure parts.
 * A person (or their agent, as a draft) sends colleagues a typed card about
 * their work: FYI ("check out what I'm working on") or Help ("I'm stuck, what
 * do you think?"). This file validates drafts, renders the Block Kit card,
 * the sender's preview and the modals, and decides when to tell the asking
 * agent about a reply. No I/O here: routes/collab.ts and slack/collab.ts do it.
 */
import { findSecretsInText } from './askPublish';
import { nudgeDecision } from './agentSpawn';

export const COLLAB_FLAG = 'slack-collab-enabled';

/** Slack mrkdwn needs &, < and > escaped (same as briefing/slack.ts, kept here so this module stays I/O-free). */
export function slackEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export const KINDS = ['fyi', 'help'] as const;
export type CollabKind = typeof KINDS[number];

export const KIND_META: Record<CollabKind, { emoji: string; label: string }> = {
  fyi: { emoji: '📣', label: 'FYI' },
  help: { emoji: '🆘', label: 'Help wanted' },
};

export const LIMITS = {
  ask: 200,
  contextItems: 6,
  contextItem: 300,
  tried: 800,
  helpWanted: 300,
  evidenceChars: 3000,
  evidenceLines: 15,
  links: 5,
  people: 8,
  replyText: 3000,
};

/** Slack action and view ids. */
export const ACTIONS = {
  send: 'collab_send',
  edit: 'collab_edit',
  cancel: 'collab_cancel',
  reply: 'collab_reply',
  fullContext: 'collab_full_context',
  resolve: 'collab_resolve',
} as const;
export const VIEWS = { reply: 'collab_reply_submit', edit: 'collab_edit_submit' } as const;

export interface CollabTo {
  /** "project" = the workstream's channel; a Slack channel id (C…); absent = a DM to people[0]. */
  channel?: string;
  /** Slack user ids (U…/W…) or emails. Resolved to ids before a draft is stored. */
  people?: string[];
}

export interface CollabDraft {
  kind: CollabKind;
  ask: string;
  context: string[];
  tried?: string;
  helpWanted?: string;
  evidence?: string;
  links: string[];
  to: CollabTo;
}

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

const TRIMMED_NOTE = '\n… (trimmed)';

/**
 * Trim an excerpt to the line and character caps, saying so when it was cut.
 * The note counts against the character cap: the Edit modal's field has that
 * max_length, and Slack refuses a view whose initial_value is longer.
 */
export function trimEvidence(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let out = lines.slice(0, LIMITS.evidenceLines).join('\n');
  let cut = lines.length > LIMITS.evidenceLines;
  const room = LIMITS.evidenceChars - TRIMMED_NOTE.length;
  if (out.length > LIMITS.evidenceChars || (cut && out.length > room)) { out = out.slice(0, room); cut = true; }
  return cut ? `${out.trimEnd()}${TRIMMED_NOTE}` : out;
}

const SLACK_ID = /^[UW][A-Z0-9]{6,}$/;
const CHANNEL_ID = /^[CG][A-Z0-9]{6,}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** A draft from an agent tool call or the web form, checked and capped. */
export function parseDraft(raw: unknown): Parsed<CollabDraft> {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'body must be an object' };
  const r = raw as Record<string, unknown>;
  const kind = r.kind;
  if (typeof kind !== 'string' || !(KINDS as readonly string[]).includes(kind)) {
    return { ok: false, error: `kind must be one of ${KINDS.join(', ')}` };
  }
  const ask = str(r.ask);
  if (!ask) return { ok: false, error: 'ask is required: one line saying what you want the reader to know or do' };
  if (ask.length > LIMITS.ask) return { ok: false, error: `ask is ${ask.length} characters; keep it to ${LIMITS.ask} (detail goes in context)` };
  if (/\n/.test(ask)) return { ok: false, error: 'ask must be one line' };

  let context: string[] = [];
  if (r.context !== undefined) {
    const items = Array.isArray(r.context) ? r.context : typeof r.context === 'string' ? r.context.split('\n') : null;
    if (!items) return { ok: false, error: 'context must be a list of short bullets' };
    context = items.map(x => (typeof x === 'string' ? x.replace(/^\s*[-•*]\s*/, '').trim() : '')).filter(Boolean);
    if (context.length > LIMITS.contextItems) return { ok: false, error: `context has ${context.length} bullets; keep it to ${LIMITS.contextItems}` };
    const long = context.find(c => c.length > LIMITS.contextItem);
    if (long) return { ok: false, error: `a context bullet is ${long.length} characters; keep each to ${LIMITS.contextItem}` };
  }

  const tried = str(r.tried);
  const helpWanted = str(r.helpWanted);
  if (tried && tried.length > LIMITS.tried) return { ok: false, error: `tried is too long (max ${LIMITS.tried})` };
  if (helpWanted && helpWanted.length > LIMITS.helpWanted) return { ok: false, error: `helpWanted is too long (max ${LIMITS.helpWanted})` };
  if (kind !== 'help' && (tried || helpWanted)) return { ok: false, error: 'tried and helpWanted are for kind "help"' };

  const evidenceRaw = str(r.evidence);
  const evidence = evidenceRaw ? trimEvidence(evidenceRaw) : undefined;

  let links: string[] = [];
  if (r.links !== undefined) {
    if (!Array.isArray(r.links) || !r.links.every(l => typeof l === 'string')) return { ok: false, error: 'links must be a list of URLs' };
    links = (r.links as string[]).map(l => l.trim()).filter(Boolean);
    if (links.length > LIMITS.links) return { ok: false, error: `at most ${LIMITS.links} links` };
    const bad = links.find(l => !/^https:\/\/\S+$/.test(l));
    if (bad) return { ok: false, error: `links must be https URLs (${bad.slice(0, 60)})` };
  }

  const toRaw = (r.to && typeof r.to === 'object' ? r.to : {}) as Record<string, unknown>;
  const to: CollabTo = {};
  const channel = str(toRaw.channel);
  if (channel) {
    if (channel !== 'project' && !CHANNEL_ID.test(channel)) {
      return { ok: false, error: 'to.channel must be "project" (this workstream\'s channel) or a Slack channel id (C…)' };
    }
    to.channel = channel;
  }
  if (toRaw.people !== undefined) {
    if (!Array.isArray(toRaw.people) || !toRaw.people.every(p => typeof p === 'string')) return { ok: false, error: 'to.people must be a list' };
    const people = (toRaw.people as string[]).map(p => p.trim()).filter(Boolean);
    if (people.length > LIMITS.people) return { ok: false, error: `at most ${LIMITS.people} people` };
    const bad = people.find(p => !SLACK_ID.test(p) && !EMAIL.test(p));
    if (bad) return { ok: false, error: `to.people entries must be Slack user ids (U…) or emails (${bad.slice(0, 60)})` };
    to.people = people;
  }
  // A DM needs exactly one person: a group DM would need the mpim:write scope.
  if (!to.channel) {
    if (!to.people?.length) to.channel = 'project';
    else if (to.people.length > 1) return { ok: false, error: 'a DM goes to one person; for several, post in a channel (to.channel "project") and mention them' };
  }
  return { ok: true, value: { kind: kind as CollabKind, ask, context, tried, helpWanted, evidence, links, to } };
}

/** Secret-shaped strings anywhere a draft would put text in Slack. */
export function draftSecrets(d: Pick<CollabDraft, 'ask' | 'context' | 'tried' | 'helpWanted' | 'evidence' | 'links'>): string[] {
  const text = [d.ask, ...d.context, d.tried ?? '', d.helpWanted ?? '', d.evidence ?? '', ...d.links].join('\n');
  return findSecretsInText(text);
}

/** A stored request as the renderers need it. */
export interface CardInput {
  id: string;
  kind: string;
  ask: string;
  context: string[];
  tried?: string | null;
  helpWanted?: string | null;
  evidence?: string | null;
  links: string[];
  state: string;
  origin: string;
  senderSlackId: string | null;
  senderName: string;
  where: { label: string; link: string | null } | null;
  /** Slack ids to cc on a channel post. */
  cc: string[];
  resolvedBy?: string | null;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function kindOf(kind: string): { emoji: string; label: string } {
  return KIND_META[kind as CollabKind] ?? { emoji: '💬', label: kind };
}

/** Plain-text header: Slack caps it at 150 characters. */
export function cardHeader(c: Pick<CardInput, 'kind' | 'ask' | 'state'>): string {
  const k = kindOf(c.kind);
  const prefix = c.state === 'resolved' ? '✅ Resolved · ' : c.state === 'canceled' ? '✖️ Withdrawn · ' : `${k.emoji} ${k.label}: `;
  return clip(`${prefix}${c.ask}`, 150);
}

function provenance(c: CardInput): string {
  const who = c.senderSlackId ? `<@${c.senderSlackId}>` : `*${slackEscape(c.senderName)}*`;
  const where = c.where ? (c.where.link ? ` · <${c.where.link}|${slackEscape(c.where.label)}>` : ` · ${slackEscape(c.where.label)}`) : '';
  const how = c.origin === 'agent' ? 'drafted with Claude in termag' : 'sent from termag';
  return `From ${who}${where} · ${how}`;
}

/**
 * The card itself. `interactive` false renders it for the sender's preview
 * (no buttons, which would act on a card that does not exist yet).
 */
export function cardBlocks(c: CardInput, opts: { interactive: boolean }): { text: string; blocks: unknown[] } {
  const blocks: unknown[] = [
    { type: 'header', text: { type: 'plain_text', text: cardHeader(c), emoji: true } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: provenance(c) }] },
  ];
  if (c.context.length) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: clip(c.context.map(x => `• ${slackEscape(x)}`).join('\n'), 2900) } });
  }
  if (c.kind === 'help') {
    if (c.tried) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: clip(`*What I tried*\n${slackEscape(c.tried)}`, 2900) } });
    if (c.helpWanted) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: clip(`*What would help*\n${slackEscape(c.helpWanted)}`, 2900) } });
  }
  if (c.links.length) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: clip(`*Links*\n${c.links.map(l => `• <${l}>`).join('\n')}`, 2900) } });
  }
  if (c.cc.length) {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `cc ${c.cc.map(id => `<@${id}>`).join(' ')}` }] });
  }
  if (c.evidence) {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: '_Evidence is in the thread._' }] });
  }
  if (c.state === 'resolved' && c.resolvedBy) {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `Resolved by <@${c.resolvedBy}>` }] });
  }
  if (opts.interactive) {
    const actions: unknown[] = [];
    if (c.state === 'open') actions.push({ type: 'button', action_id: ACTIONS.reply, text: { type: 'plain_text', text: 'Reply' }, value: c.id, style: 'primary' });
    actions.push({ type: 'button', action_id: ACTIONS.fullContext, text: { type: 'plain_text', text: 'Full context' }, value: c.id });
    if (c.where?.link) actions.push({ type: 'button', action_id: 'collab_open_link', text: { type: 'plain_text', text: 'Open in termag' }, url: c.where.link });
    blocks.push({ type: 'actions', elements: actions });
  }
  const k = kindOf(c.kind);
  return { text: clip(`${k.label} from ${c.senderName}: ${c.ask}`, 300), blocks };
}

/** The evidence excerpt as a code block, the card's first thread reply. */
export function evidenceText(evidence: string): string {
  // Triple backticks inside would end the block early.
  return `*Evidence*\n\`\`\`${slackEscape(evidence.replace(/```/g, "'''"))}\`\`\``;
}

/** What the sender sees before anything is posted. */
export function previewBlocks(c: CardInput, destination: string): { text: string; blocks: unknown[] } {
  const card = cardBlocks(c, { interactive: false });
  const blocks: unknown[] = [
    { type: 'section', text: { type: 'mrkdwn', text: `*Preview.* Nothing is posted until you press Send. It goes to ${destination}.` } },
    { type: 'divider' },
    ...card.blocks,
  ];
  if (c.evidence) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: clip(evidenceText(c.evidence), 2900) } });
  blocks.push({ type: 'divider' });
  blocks.push({
    type: 'actions',
    elements: [
      { type: 'button', action_id: ACTIONS.send, text: { type: 'plain_text', text: 'Send' }, value: c.id, style: 'primary' },
      { type: 'button', action_id: ACTIONS.edit, text: { type: 'plain_text', text: 'Edit' }, value: c.id },
      { type: 'button', action_id: ACTIONS.cancel, text: { type: 'plain_text', text: 'Cancel' }, value: c.id, style: 'danger' },
    ],
  });
  return { text: `Preview: ${card.text}`, blocks };
}

/** The preview once acted on: the buttons go, a line says what happened. */
export function previewDoneBlocks(c: CardInput, outcome: string): { text: string; blocks: unknown[] } {
  const card = cardBlocks(c, { interactive: false });
  return {
    text: outcome,
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text: outcome } }, { type: 'divider' }, ...card.blocks],
  };
}

/** "Full context": everything about the request, readable without termag. */
export function fullContextView(c: CardInput): unknown {
  const blocks: unknown[] = [
    { type: 'section', text: { type: 'mrkdwn', text: `*${slackEscape(cardHeader(c))}*` } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: provenance(c) }] },
  ];
  if (c.context.length) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: clip(`*Context*\n${c.context.map(x => `• ${slackEscape(x)}`).join('\n')}`, 2900) } });
  if (c.tried) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: clip(`*What I tried*\n${slackEscape(c.tried)}`, 2900) } });
  if (c.helpWanted) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: clip(`*What would help*\n${slackEscape(c.helpWanted)}`, 2900) } });
  if (c.evidence) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: clip(evidenceText(c.evidence), 2900) } });
  if (c.links.length) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: clip(`*Links*\n${c.links.map(l => `• <${l}>`).join('\n')}`, 2900) } });
  return { type: 'modal', title: { type: 'plain_text', text: 'Full context' }, close: { type: 'plain_text', text: 'Close' }, blocks };
}

export function replyView(requestId: string, ask: string): unknown {
  return {
    type: 'modal',
    callback_id: VIEWS.reply,
    private_metadata: requestId,
    title: { type: 'plain_text', text: 'Reply' },
    submit: { type: 'plain_text', text: 'Send reply' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `*${slackEscape(clip(ask, 2800))}*` } },
      {
        type: 'input', block_id: 'reply',
        label: { type: 'plain_text', text: 'Your reply' },
        element: { type: 'plain_text_input', action_id: 'text', multiline: true, max_length: LIMITS.replyText },
      },
    ],
  };
}

export function editView(c: Pick<CardInput, 'id' | 'kind' | 'ask' | 'context' | 'tried' | 'helpWanted' | 'evidence'>): unknown {
  const text = (block: string, label: string, value: string | null | undefined, opts: { multiline?: boolean; optional?: boolean; max: number }) => ({
    type: 'input', block_id: block, optional: opts.optional ?? false,
    label: { type: 'plain_text', text: label },
    element: {
      type: 'plain_text_input', action_id: 'v', multiline: opts.multiline ?? false, max_length: opts.max,
      ...(value ? { initial_value: value } : {}),
    },
  });
  const blocks: unknown[] = [
    text('ask', 'The ask (one line)', c.ask, { max: LIMITS.ask }),
    text('context', 'Context (one bullet per line)', c.context.join('\n'), { multiline: true, optional: true, max: LIMITS.contextItems * (LIMITS.contextItem + 1) }),
  ];
  if (c.kind === 'help') {
    blocks.push(text('tried', 'What I tried', c.tried, { multiline: true, optional: true, max: LIMITS.tried }));
    blocks.push(text('helpWanted', 'What would help', c.helpWanted, { optional: true, max: LIMITS.helpWanted }));
  }
  blocks.push(text('evidence', 'Evidence excerpt (posted in the thread)', c.evidence, { multiline: true, optional: true, max: LIMITS.evidenceChars }));
  return {
    type: 'modal', callback_id: VIEWS.edit, private_metadata: c.id,
    title: { type: 'plain_text', text: 'Edit before sending' },
    submit: { type: 'plain_text', text: 'Update preview' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks,
  };
}

/** A Slack view_submission's `state.values` for the edit modal, as draft fields. */
export function editValues(values: Record<string, Record<string, { value?: string | null }>>): Record<string, unknown> {
  const v = (block: string) => values?.[block]?.v?.value ?? undefined;
  return {
    ask: v('ask'),
    context: (v('context') ?? '').split('\n'),
    tried: v('tried'),
    helpWanted: v('helpWanted'),
    evidence: v('evidence'),
  };
}

/** The one fixed line typed into the asking agent's pane. Never contains reply text. */
export function collabNudgeLine(requestId: string, count: number): string {
  return `[termag] ${count === 1 ? 'a new reply' : `${count} new replies`} to your Slack request ${requestId}. Call slack_inbox (metaterm MCP server) to read ${count === 1 ? 'it' : 'them'}.`;
}

/** Same rules as the spawn nudge: only an idle, connected agent pane, not while its person is typing. */
export function collabNudgeDecision(n: {
  fromRole: string | null;
  fromSession: string | null;
  replyAt: Date;
  sessionStatus: string | null;
  sessionConnected: boolean;
  humanLastTyped: number | null;
  now: number;
}): 'nudge' | 'wait' | 'skip' {
  return nudgeDecision({
    relationship: 'delegate',
    parentRole: n.fromRole,
    reportedAt: n.replyAt,
    nudgedAt: null,
    parentSession: n.fromSession,
    parentStatus: n.sessionStatus,
    parentConnected: n.sessionConnected,
    humanLastTyped: n.humanLastTyped,
    now: n.now,
  });
}

/** JSON columns read back as string arrays, ignoring anything else. */
export function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}
