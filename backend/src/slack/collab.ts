/**
 * Slack collaboration, phase 1: the Slack side.
 *
 *   preview   DM the sender the card with Send / Edit / Cancel (agent drafts)
 *   send      post the card for the sender, evidence as the first thread reply
 *   reply     the card's Reply modal, and thread replies under the card
 *   notify    DM the sender each reply, with Resolve
 *   resolve   the sender closes it: the card updates in place
 *
 * Posting uses the Web API client, which works on every instance; buttons,
 * modals and thread messages arrive through Socket Mode, i.e. on the lease
 * holder. Only the sender may send, edit, cancel or resolve: every action
 * checks the clicking Slack user against the request's owner.
 */
import { prisma } from '../db';
import { sessionLink, slackIdFor, webBase } from '../services/briefing/slack';
import {
  ACTIONS,
  VIEWS,
  cardBlocks,
  draftSecrets,
  editValues,
  editView,
  evidenceText,
  fullContextView,
  parseDraft,
  previewBlocks,
  previewDoneBlocks,
  replyView,
  slackEscape,
  strings,
  LIMITS,
  KIND_META,
  type CardInput,
  type CollabKind,
} from '../services/collab';
import { getSlackApp } from './app';
import { createChannelFor } from './channels';

type Row = NonNullable<Awaited<ReturnType<typeof loadRequest>>>;

async function loadRequest(id: string) {
  return prisma.collabRequest.findUnique({
    where: { id },
    include: { user: { select: { id: true, displayName: true, slackUserId: true, googleEmail: true, unixUsername: true } } },
  });
}

async function whereOf(row: Pick<Row, 'projectId' | 'workstream'>): Promise<CardInput['where']> {
  if (!row.projectId) return null;
  const project = await prisma.project.findUnique({ where: { id: row.projectId }, select: { name: true } });
  if (!project) return null;
  const ws = row.workstream && row.workstream !== 'main' ? row.workstream : null;
  return { label: ws ? `${project.name} · ${ws}` : project.name, link: sessionLink(webBase(), row.projectId, row.workstream) };
}

async function cardInputFor(row: Row): Promise<CardInput> {
  const people = strings(row.toPeople);
  return {
    id: row.id,
    kind: row.kind,
    ask: row.ask,
    context: strings(row.context),
    tried: row.tried,
    helpWanted: row.helpWanted,
    evidence: row.evidence,
    links: strings(row.links),
    state: row.state,
    origin: row.origin,
    senderSlackId: row.user.slackUserId,
    senderName: row.user.displayName,
    where: await whereOf(row),
    // A DM's one recipient is the conversation itself; cc is for channel posts.
    cc: row.toChannel ? people : [],
    resolvedBy: row.resolvedBy,
  };
}

/** Where the card will go, in words, for the preview. */
async function destinationLabel(row: Row): Promise<string> {
  const people = strings(row.toPeople);
  if (!row.toChannel) return `a DM to <@${people[0]}>`;
  const cc = people.length ? ` (cc ${people.map(p => `<@${p}>`).join(' ')})` : '';
  if (row.toChannel === 'project') {
    const where = await whereOf(row);
    return `this workstream's channel${where ? ` (${slackEscape(where.label)})` : ''}${cc}`;
  }
  return `<#${row.toChannel}>${cc}`;
}

/** Slack user ids for a list of ids or emails; emails that match nobody come back in `missing`. */
export async function resolvePeople(client: any, people: string[]): Promise<{ ids: string[]; missing: string[] }> {
  const ids: string[] = [];
  const missing: string[] = [];
  for (const p of people) {
    if (!p.includes('@')) { ids.push(p); continue; }
    try {
      const r = await client.users.lookupByEmail({ email: p });
      if (r?.user?.id) ids.push(r.user.id);
      else missing.push(p);
    } catch {
      missing.push(p);
    }
  }
  return { ids: [...new Set(ids)], missing };
}

/** The channel id to post in: the workstream's channel (made if missing), a named channel, or a DM. */
async function channelFor(client: any, row: Row): Promise<string> {
  if (row.toChannel && row.toChannel !== 'project') return row.toChannel;
  if (!row.toChannel) {
    const people = strings(row.toPeople);
    const r = await client.conversations.open({ users: people[0] });
    const id = r?.channel?.id as string | undefined;
    if (!id) throw new Error('could not open a DM with that person');
    return id;
  }
  if (!row.projectId) throw new Error('this request has no project, so there is no project channel to post in');
  const project = await prisma.project.findUnique({ where: { id: row.projectId }, select: { id: true, name: true, slackChannelId: true } });
  if (!project) throw new Error('the project is gone');
  const wsName = row.workstream ?? 'main';
  if (wsName === 'main') {
    if (project.slackChannelId) return project.slackChannelId;
    const id = await createChannelFor({ username: row.user.unixUsername, projectName: project.name, creatorSlackUserId: row.user.slackUserId ?? undefined });
    if (!id) throw new Error('could not create the project channel');
    await prisma.project.update({ where: { id: project.id }, data: { slackChannelId: id } });
    return id;
  }
  const ws = await prisma.workstream.findUnique({ where: { projectId_name: { projectId: project.id, name: wsName } }, select: { id: true, slackChannelId: true } });
  if (ws?.slackChannelId) return ws.slackChannelId;
  const id = await createChannelFor({ username: row.user.unixUsername, projectName: project.name, workstream: wsName, creatorSlackUserId: row.user.slackUserId ?? undefined });
  if (!id) throw new Error('could not create the workstream channel');
  if (ws) await prisma.workstream.update({ where: { id: ws.id }, data: { slackChannelId: id } });
  return id;
}

/** DM the sender the preview. Returns false when they have no Slack account termag can find. */
export async function deliverPreview(requestId: string): Promise<boolean> {
  const client = getSlackApp()?.client;
  const row = await loadRequest(requestId);
  if (!client || !row || row.state !== 'draft') return false;
  const dm = await slackIdFor(client, row.user);
  if (!dm) return false;
  const msg = previewBlocks(await cardInputFor({ ...row, user: { ...row.user, slackUserId: dm } }), await destinationLabel(row));
  const posted = await client.chat.postMessage({ channel: dm, ...msg });
  await prisma.collabRequest.update({ where: { id: row.id }, data: { previewChannel: posted.channel ?? dm, previewTs: posted.ts ?? null } });
  return true;
}

export type SendOutcome = { ok: true; permalink: string | null } | { ok: false; error: string };

/**
 * Post a draft as its sender. `actorSlackId` must be the sender's own Slack
 * id: a Send pressed by anyone else is refused. Claims the row first, so a
 * double click posts once.
 */
export async function sendRequest(requestId: string, actorSlackId: string, opts: { authenticatedSender?: boolean } = {}): Promise<SendOutcome> {
  const client = getSlackApp()?.client;
  if (!client) return { ok: false, error: 'Slack is not configured on this orchestrator' };
  const row = await loadRequest(requestId);
  if (!row) return { ok: false, error: 'that request no longer exists' };
  // A Slack button is checked against the owner's linked Slack id. The web
  // form's caller is already the owner (its session), so it is trusted even
  // when the slackUserId link write behind slackIdFor did not stick.
  if (!opts.authenticatedSender && (!row.user.slackUserId || row.user.slackUserId !== actorSlackId)) {
    return { ok: false, error: 'only the person it is from can send it' };
  }
  if (row.state !== 'draft') return { ok: false, error: `it is already ${row.state}` };
  const secrets = draftSecrets({ ask: row.ask, context: strings(row.context), tried: row.tried ?? undefined, helpWanted: row.helpWanted ?? undefined, evidence: row.evidence ?? undefined, links: strings(row.links) });
  if (secrets.length) return { ok: false, error: `it looks like it contains a secret (${secrets.join(', ')}); edit it out first` };

  const claimed = await prisma.collabRequest.updateMany({ where: { id: row.id, state: 'draft' }, data: { state: 'sending' } });
  if (claimed.count !== 1) return { ok: false, error: 'it is already being sent' };

  // Only a failure BEFORE Slack accepts the card puts it back to draft. Once
  // the card exists, the row must point at it (or thread replies go
  // unclaimed and a second Send posts a second card), so it never goes back.
  let channel: string;
  let ts: string;
  try {
    channel = await channelFor(client, row);
    const card = cardBlocks(await cardInputFor({ ...row, state: 'open' }), { interactive: true });
    const posted = await client.chat.postMessage({ channel, ...card, unfurl_links: false });
    ts = posted.ts as string;
    channel = (posted.channel as string | undefined) ?? channel;
  } catch (err) {
    await prisma.collabRequest.updateMany({ where: { id: row.id, state: 'sending' }, data: { state: 'draft' } }).catch(() => {});
    console.warn(`[COLLAB] ${row.id} send failed:`, (err as Error).message);
    return { ok: false, error: `Slack refused it: ${(err as Error).message}` };
  }

  // Record where it went first, retried, before anything else can fail.
  const posted = { state: 'open', slackChannel: channel, slackTs: ts, sentAt: new Date() };
  if (!(await saveWithRetry(row.id, posted))) {
    console.error(`[COLLAB] ${row.id} posted as ${channel}/${ts} but the row could not be updated; left in "sending" so it is not sent twice`);
    return { ok: false, error: 'it was posted, but termag could not record it; replies to it may not reach you' };
  }

  if (row.evidence) {
    await client.chat.postMessage({ channel, thread_ts: ts, text: evidenceText(row.evidence) }).catch((err: Error) => console.warn('[COLLAB] evidence reply failed:', err.message));
  }
  const permalink = await client.chat.getPermalink({ channel, message_ts: ts }).then((r: any) => r?.permalink ?? null).catch(() => null);
  if (permalink) await prisma.collabRequest.update({ where: { id: row.id }, data: { permalink } }).catch(() => {});
  if (row.previewChannel && row.previewTs) {
    const done = previewDoneBlocks(await cardInputFor({ ...row, state: 'open' }), `✅ Sent${permalink ? ` — <${permalink}|view it>` : ''}.`);
    await client.chat.update({ channel: row.previewChannel, ts: row.previewTs, ...done }).catch(() => {});
  }
  console.log(`[COLLAB] ${row.id} sent by ${row.user.unixUsername} to ${channel}`);
  return { ok: true, permalink };
}

async function saveWithRetry(id: string, data: Record<string, unknown>, attempts = 3): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    try {
      await prisma.collabRequest.update({ where: { id }, data });
      return true;
    } catch (err) {
      console.warn(`[COLLAB] ${id} save attempt ${i + 1} failed:`, (err as Error).message);
      if (i < attempts - 1) await new Promise(r => setTimeout(r, 250 * (i + 1)));
    }
  }
  return false;
}

async function responderName(client: any, slackId: string): Promise<string | null> {
  try {
    const r = await client.users.info({ user: slackId });
    return (r?.user?.real_name || r?.user?.profile?.display_name || r?.user?.name) ?? null;
  } catch {
    return null;
  }
}

/**
 * Store one reply and tell the sender. A thread reply is keyed by its ts, so
 * a redelivered event is stored once. The sender's own messages are stored
 * and nudge the drafting agent like any reply (they may answer the question
 * themselves), but are not DMed back to them.
 */
export async function recordResponse(row: Row, r: { slackId: string; text: string; source: 'thread' | 'modal'; ts: string | null }): Promise<void> {
  const client = getSlackApp()?.client;
  const text = r.text.slice(0, LIMITS.replyText);
  let created;
  try {
    created = await prisma.collabResponse.create({
      data: {
        requestId: row.id, responderSlackId: r.slackId, text, source: r.source, slackTs: r.ts,
        responderName: client ? safeName(await responderName(client, r.slackId)) : null,
        // The sender needs no DM about their own words. The agent still gets
        // the nudge: it never sees what was typed in Slack otherwise.
        ...(r.slackId === row.user.slackUserId ? { notifiedAt: new Date() } : {}),
      },
    });
  } catch (err) {
    if ((err as { code?: string }).code === 'P2002') return; // already stored
    throw err;
  }
  if (r.slackId === row.user.slackUserId) return;
  await notifyResponse(created.id);
}

/** A Slack display name as one short line, so it cannot break framing where it is printed. */
export function safeName(name: string | null): string | null {
  if (!name) return null;
  const one = name.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/[[\]]/g, '').replace(/\s+/g, ' ').trim();
  return one ? one.slice(0, 80) : null;
}

/**
 * DM the sender about one reply. Claimed first (notifiedAt), so the retry
 * pass in collabSweep.ts and a live call never both send it; released on
 * failure so the retry pass tries again. Returns whether a DM went out.
 */
export async function notifyResponse(responseId: string): Promise<boolean> {
  const client = getSlackApp()?.client;
  if (!client) return false;
  const claimed = await prisma.collabResponse.updateMany({ where: { id: responseId, notifiedAt: null }, data: { notifiedAt: new Date() } });
  if (claimed.count !== 1) return false;
  const release = () => prisma.collabResponse.updateMany({ where: { id: responseId }, data: { notifiedAt: null } }).catch(() => {});
  const resp = await prisma.collabResponse.findUnique({ where: { id: responseId } });
  const row = resp ? await loadRequest(resp.requestId) : null;
  if (!resp || !row) return false;
  const dm = await slackIdFor(client, row.user);
  // No Slack account to tell: leave it claimed, there is nobody to retry for.
  if (!dm) return false;
  const kind = KIND_META[row.kind as CollabKind]?.label ?? row.kind;
  const quoted = resp.text.split('\n').slice(0, 12).map(l => `> ${slackEscape(l)}`).join('\n');
  const elements: unknown[] = [];
  if (row.permalink) elements.push({ type: 'button', action_id: 'collab_open_thread', text: { type: 'plain_text', text: 'Open thread' }, url: row.permalink });
  if (row.state === 'open') elements.push({ type: 'button', action_id: ACTIONS.resolve, text: { type: 'plain_text', text: 'Mark resolved' }, value: row.id });
  try {
    await client.chat.postMessage({
      channel: dm,
      text: `${resp.responderName ?? 'Someone'} replied to your ${kind}: ${row.ask}`.slice(0, 300),
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: `<@${resp.responderSlackId}> replied to your ${kind.toLowerCase()} *${slackEscape(row.ask)}*\n${quoted}`.slice(0, 2900) } },
        ...(elements.length ? [{ type: 'actions', elements }] : []),
      ],
    });
    return true;
  } catch (err) {
    console.warn(`[COLLAB] reply DM for ${responseId} failed, will retry:`, (err as Error).message);
    await release();
    return false;
  }
}

/**
 * A message event: if it is a reply in a collaboration card's thread, store it
 * and return true, so the DM executor does not also answer it.
 */
export async function handleCollabThreadMessage(event: any): Promise<boolean> {
  if (!event?.thread_ts || event.thread_ts === event.ts || !event.channel) return false;
  const row = await prisma.collabRequest.findFirst({
    where: { slackChannel: event.channel, slackTs: event.thread_ts, state: { in: ['open', 'resolved'] } },
    include: { user: { select: { id: true, displayName: true, slackUserId: true, googleEmail: true, unixUsername: true } } },
  });
  if (!row) return false;
  // Ours, even when we do not store it: the bot's own posts, edits, deletes.
  if (event.bot_id || !event.user || !REPLY_SUBTYPES.has(event.subtype)) return true;
  const text = replyText(event);
  if (!text) return true;
  await recordResponse(row, { slackId: event.user, text, source: 'thread', ts: event.ts });
  return true;
}

/** Message subtypes that are a person's reply: plain, "also send to channel", and file shares. */
const REPLY_SUBTYPES = new Set<string | undefined>([undefined, 'thread_broadcast', 'file_share']);

/** A reply's text, with any shared files named (their contents are never fetched). */
export function replyText(event: { text?: unknown; files?: unknown }): string {
  const text = typeof event.text === 'string' ? event.text.trim() : '';
  const files = Array.isArray(event.files)
    ? event.files.map((f: any) => safeName(f?.name ?? f?.title ?? null)).filter((n): n is string => !!n)
    : [];
  return [text, files.length ? `(shared ${files.join(', ')})` : ''].filter(Boolean).join('\n');
}

/** The sender closes it: the card shows Resolved and loses its Reply button. */
export async function resolveRequest(requestId: string, actorSlackId: string): Promise<SendOutcome> {
  const client = getSlackApp()?.client;
  const row = await loadRequest(requestId);
  if (!client || !row) return { ok: false, error: 'that request no longer exists' };
  if (row.user.slackUserId !== actorSlackId) return { ok: false, error: 'only the person it is from can resolve it' };
  if (row.state !== 'open') return { ok: false, error: `it is ${row.state}` };
  await prisma.collabRequest.update({ where: { id: row.id }, data: { state: 'resolved', resolvedAt: new Date(), resolvedBy: actorSlackId } });
  if (row.slackChannel && row.slackTs) {
    const card = cardBlocks(await cardInputFor({ ...row, state: 'resolved', resolvedBy: actorSlackId }), { interactive: true });
    await client.chat.update({ channel: row.slackChannel, ts: row.slackTs, ...card }).catch(() => {});
    await client.chat.postMessage({ channel: row.slackChannel, thread_ts: row.slackTs, text: `✅ Marked resolved by <@${actorSlackId}>.` }).catch(() => {});
  }
  return { ok: true, permalink: row.permalink };
}

async function cancelRequest(requestId: string, actorSlackId: string): Promise<SendOutcome> {
  const client = getSlackApp()?.client;
  const row = await loadRequest(requestId);
  if (!client || !row) return { ok: false, error: 'that request no longer exists' };
  if (row.user.slackUserId !== actorSlackId) return { ok: false, error: 'only the person it is from can cancel it' };
  // "sending" is a Send that never got recorded (see sendRequest): it can be
  // withdrawn too, though the card may exist in Slack.
  const done = await prisma.collabRequest.updateMany({ where: { id: row.id, state: { in: ['draft', 'sending'] } }, data: { state: 'canceled' } });
  if (done.count !== 1) return { ok: false, error: `it is already ${row.state}` };
  if (row.previewChannel && row.previewTs) {
    const outcome = row.state === 'sending'
      ? '✖️ Canceled. A Send was in flight: if the card was posted, delete it in Slack.'
      : '✖️ Canceled. Nothing was posted.';
    const blocks = previewDoneBlocks(await cardInputFor({ ...row, state: 'canceled' }), outcome);
    await client.chat.update({ channel: row.previewChannel, ts: row.previewTs, ...blocks }).catch(() => {});
  }
  return { ok: true, permalink: null };
}

/** Tell the clicking user something only they see, in the channel they clicked in. */
async function tell(client: any, body: any, text: string): Promise<void> {
  const user = body?.user?.id;
  const channel = body?.channel?.id ?? body?.container?.channel_id;
  if (!user) return;
  if (channel) {
    await client.chat.postEphemeral({ channel, user, text }).catch(() => client.chat.postMessage({ channel: user, text }).catch(() => {}));
  } else {
    await client.chat.postMessage({ channel: user, text }).catch(() => {});
  }
}

export function registerCollabSlackActions(app: any): void {
  app.action(ACTIONS.send, async ({ ack, body, client, action }: any) => {
    await ack();
    const out = await sendRequest(String(action?.value ?? ''), body?.user?.id);
    if (!out.ok) await tell(client, body, `Not sent: ${out.error}`);
  });

  app.action(ACTIONS.cancel, async ({ ack, body, client, action }: any) => {
    await ack();
    const out = await cancelRequest(String(action?.value ?? ''), body?.user?.id);
    if (!out.ok) await tell(client, body, `Not canceled: ${out.error}`);
  });

  app.action(ACTIONS.edit, async ({ ack, body, client, action }: any) => {
    await ack();
    const row = await loadRequest(String(action?.value ?? ''));
    if (!row || row.state !== 'draft' || row.user.slackUserId !== body?.user?.id) {
      await tell(client, body, 'Only the person it is from can edit a draft that has not been sent.');
      return;
    }
    await client.views.open({ trigger_id: body.trigger_id, view: editView({ ...row, context: strings(row.context) }) });
  });

  app.view(VIEWS.edit, async ({ ack, body, view, client }: any) => {
    const row = await loadRequest(String(view?.private_metadata ?? ''));
    if (!row || row.state !== 'draft' || row.user.slackUserId !== body?.user?.id) {
      await ack({ response_action: 'errors', errors: { ask: 'This draft can no longer be edited.' } });
      return;
    }
    const fields = editValues(view?.state?.values ?? {});
    const parsed = parseDraft({
      kind: row.kind, ...fields, links: strings(row.links),
      to: row.toChannel ? { channel: row.toChannel, people: strings(row.toPeople) } : { people: strings(row.toPeople) },
    });
    if (!parsed.ok) { await ack({ response_action: 'errors', errors: { ask: parsed.error.slice(0, 150) } }); return; }
    const secrets = draftSecrets(parsed.value);
    if (secrets.length) { await ack({ response_action: 'errors', errors: { evidence: `Looks like a secret (${secrets.join(', ')}). Remove it.` } }); return; }
    await ack();
    const d = parsed.value;
    // Conditional on the row still being a draft: a Send landing between the
    // read above and this write must win, not be overwritten.
    const edited = await prisma.collabRequest.updateMany({
      where: { id: row.id, state: 'draft' },
      data: { ask: d.ask, context: d.context, tried: d.tried ?? null, helpWanted: d.helpWanted ?? null, evidence: d.evidence ?? null },
    });
    if (edited.count !== 1) { await tell(client, body, 'Not edited: it was sent (or canceled) while you were editing.'); return; }
    const fresh = await loadRequest(row.id);
    if (fresh && fresh.previewChannel && fresh.previewTs) {
      const msg = previewBlocks(await cardInputFor(fresh), await destinationLabel(fresh));
      await client.chat.update({ channel: fresh.previewChannel, ts: fresh.previewTs, ...msg }).catch(() => {});
    }
  });

  app.action(ACTIONS.reply, async ({ ack, body, client, action }: any) => {
    await ack();
    const row = await loadRequest(String(action?.value ?? ''));
    if (!row || row.state !== 'open') { await tell(client, body, 'This one is closed.'); return; }
    await client.views.open({ trigger_id: body.trigger_id, view: replyView(row.id, row.ask) });
  });

  app.view(VIEWS.reply, async ({ ack, body, view, client }: any) => {
    const text = String(view?.state?.values?.reply?.text?.value ?? '').trim();
    if (!text) { await ack({ response_action: 'errors', errors: { reply: 'Write a reply first.' } }); return; }
    await ack();
    const row = await loadRequest(String(view?.private_metadata ?? ''));
    const slackId = body?.user?.id as string | undefined;
    if (!row || !slackId || !row.slackChannel || !row.slackTs) return;
    // The thread is the record: the reply goes there too, attributed.
    const posted = await client.chat.postMessage({
      channel: row.slackChannel, thread_ts: row.slackTs,
      text: `<@${slackId}>: ${slackEscape(text)}`.slice(0, 3900),
    }).catch(() => null);
    await recordResponse(row, { slackId, text, source: 'modal', ts: posted?.ts ?? null });
  });

  app.action(ACTIONS.fullContext, async ({ ack, body, client, action }: any) => {
    await ack();
    const row = await loadRequest(String(action?.value ?? ''));
    if (!row) return;
    await client.views.open({ trigger_id: body.trigger_id, view: fullContextView(await cardInputFor(row)) });
  });

  app.action(ACTIONS.resolve, async ({ ack, body, client, action }: any) => {
    await ack();
    const out = await resolveRequest(String(action?.value ?? ''), body?.user?.id);
    if (!out.ok) await tell(client, body, `Not resolved: ${out.error}`);
    else await tell(client, body, '✅ Marked resolved.');
  });

  // URL buttons still send an action; acknowledge so Slack shows no error.
  for (const id of ['collab_open_link', 'collab_open_thread']) {
    app.action(id, async ({ ack }: any) => { await ack(); });
  }
}
