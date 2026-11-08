/**
 * Linking from termag: a space's Slack
 * channels, managed from the space dialog and `termag space slack`. Mounted by
 * index.ts in front of the spaces router, at the same two places:
 *
 *   /termag/api/spaces          browser (requireAuth), links recorded as `via: web`
 *   /termag/api/cli/v1/spaces   CLI (cliBearer), links recorded as `via: cli`
 *
 * | Route                                        | Who          | Does                                      |
 * |----------------------------------------------|--------------|-------------------------------------------|
 * | GET    /:space/slack                         | members      | enabled, runner, box, status, caps, channels |
 * | GET    /slack/channels?query=&cursor=&space= | owners of a space | the channel picker (picker.ts)       |
 * | POST   /:space/slack/channels/preview        | owners       | {channelId} or {create}: bystanders, needsInvite, firstLink |
 * | POST   /:space/slack/channels                | owners       | commit the link (or create), runner.box on a first link |
 * | GET    /:space/slack/channels/:channelId     | owners       | the unlink preview (threads, canArchive)  |
 * | DELETE /:space/slack/channels/:channelId     | owners       | unlink; ?archive=true for channels termag created |
 * | POST   /:space/slack/pause, /resume          | owners       | pause or resume answers                   |
 * | POST   /:space/slack/runner                  | the runner, then the offered owner | hand over the runner |
 * | DELETE /:space/slack                         | owners       | disable: unlink all                       |
 *
 * A space the caller isn't in is the spaces API's own 404 `not_found`; with
 * space-channels-enabled off for the caller, every route is 404
 * `space_channels_off` (the server is authoritative; the dialog only hides).
 * Writes need a person (`box_credential` for a box's token), and owners
 * (confirmed decision 1): the link service checks that again.
 */
import { Router, type Request, type RequestHandler, type Response } from 'express';
import { asyncHandler } from '../middleware/errors';
import { canManage, resolveSpaceAccess, type SpaceAccess, type SpaceCaller } from '../services/spaces/spaceAccess';
import { ancestorsOf } from '../services/spaces/spaceInheritance';
import type { SpaceRecord } from '../services/spaces/spaceStore';
import { DEFAULT_RUNNER_BOX, type RunnerBoxChoice } from '../services/spaceSlack/enable';
import { link, noThreadFreezer, unlink, type LinkActor, type LinkRefusal, type LinkSlackClient, type LinkVia } from '../services/spaceSlack/link';
import type { SpaceChannelRow } from '../services/spaceSlack/linkStore';
import {
  disable, handOverRunner, pendingRunnerOf, setPaused, type ManageDeps, type ManageRefusal, type RunnerRequest,
} from '../services/spaceSlack/manage';
import { newPickerCache, pickChannels, type PickerSlackClient } from '../services/spaceSlack/picker';

export interface SpaceSlackRouterDeps {
  /** The link and manage services' wiring, read per request (the Slack app may start after the router). */
  services: () => Promise<ManageDeps & { slack: (LinkSlackClient & PickerSlackClient) | null }>;
  /** Who is calling, from whatever the mount authenticated; null is a 401. */
  caller: (req: Request, res: Response) => SpaceCaller | null;
  /** The entry point links are recorded with. */
  via: Extract<LinkVia, 'web' | 'cli'>;
  /** 'fake' when the staging fake workspace answers (fakeWorkspace.ts), for the status view. */
  slackMode?: () => 'slack' | 'fake' | 'none';
}

class HttpFailure extends Error {
  constructor(readonly status: number, message: string, readonly code: string, readonly extra: Record<string, unknown> = {}) { super(message); }
}

function fail(status: number, message: string, code: string, extra: Record<string, unknown> = {}): never {
  throw new HttpFailure(status, message, code, extra);
}

function handler(fn: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return asyncHandler(async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof HttpFailure) { res.status(err.status).json({ error: err.message, code: err.code, ...err.extra }); return; }
      throw err;
    }
  });
}

/** The HTTP status each refusal answers with; the code goes in the body. */
export const REFUSAL_STATUS: Record<LinkRefusal | ManageRefusal, number> = {
  space_channels_off: 404,
  space_not_found: 404,
  not_linked: 404,
  not_owner: 403,
  not_in_channel: 403,
  not_runner: 403,
  not_an_owner: 400,
  private_not_allowed: 403,
  restricted_action: 403,
  channel_dm: 400,
  channel_workstream: 400,
  channel_ext_shared: 400,
  channel_archived: 400,
  name_invalid: 400,
  runner_no_box: 400,
  channel_linked: 409,
  too_many_channels: 409,
  needs_invite: 409,
  name_taken: 409,
  actor_not_in_slack: 409,
  not_enabled: 409,
  no_offer: 409,
  suspended: 409,
  already: 409,
  slack_error: 502,
};

/**
 * The link service's text is written for Slack (mrkdwn bold, `/t link`);
 * here it is plain, and needs_invite says what to do from termag.
 */
function webText(code: string, message: string): string {
  if (code === 'needs_invite') return 'termag isn\'t in this private channel: invite it with `/invite @termag` in the channel, then link it again.';
  return message.replace(/\*([^*\n]+)\*/g, '$1');
}

function refused(r: { code: LinkRefusal | ManageRefusal; message: string; suggestion?: string; error?: string }): never {
  if (r.code === 'slack_error' && r.error === 'slack_not_configured') {
    fail(503, 'Slack isn\'t configured on this termag', 'slack_not_configured');
  }
  fail(REFUSAL_STATUS[r.code] ?? 400, webText(r.code, r.message), r.code, {
    ...(r.suggestion ? { suggestion: r.suggestion } : {}), ...(r.error ? { slackError: r.error } : {}),
  });
}

function bodyOf(req: Request): Record<string, unknown> {
  return req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
}

function channelView(c: SpaceChannelRow, emails: Map<string, string>) {
  return {
    channelId: c.channelId, name: c.name, private: c.isPrivate, createdByTermag: c.createdByTermag,
    linkedBy: { userId: c.linkedById, email: emails.get(c.linkedById) ?? null },
    linkedVia: c.linkedVia, linkedAt: c.linkedAt.toISOString(), paused: !!c.pausedAt,
  };
}

export function spaceSlackRouter(deps: SpaceSlackRouterDeps): Router {
  const router = Router();
  const pickerCache = newPickerCache();

  function callerOf(req: Request, res: Response): SpaceCaller {
    const caller = deps.caller(req, res);
    if (!caller) fail(401, 'Unauthorized', 'auth_required');
    return caller;
  }

  function person(caller: SpaceCaller): LinkActor {
    if (caller.kind === 'box') {
      fail(403, 'A box cannot manage a space\'s Slack; run this from your laptop after `termag login`, or in the termag UI', 'box_credential');
    }
    return { userId: caller.userId };
  }

  async function accessFor(d: ManageDeps, caller: SpaceCaller, space: SpaceRecord): Promise<SpaceAccess | null> {
    const { spaces } = d;
    const [members, grantedBoxIds] = await Promise.all([spaces.memberRoles(space.id), spaces.grantedBoxIds(space.id)]);
    if (caller.kind === 'user') return resolveSpaceAccess(caller, { space, members, grantedBoxIds });
    const box = await spaces.box(caller.instanceId);
    const ancestors = box ? await ancestorsOf(box, id => spaces.box(id)) : [];
    return resolveSpaceAccess(caller, { space, members, grantedBoxIds, box, ancestors });
  }

  /** The space, for a member with the flag on; `owner` also needs a person who owns it. */
  async function load(req: Request, res: Response, need: 'member' | 'owner') {
    const d = await deps.services();
    const caller = callerOf(req, res);
    const space = await d.spaces.findSpace(String(req.params.space ?? ''));
    const access = space ? await accessFor(d, caller, space) : null;
    if (!space || !access) fail(404, 'Not found', 'not_found');
    if (!await d.channelsEnabled(caller.userId)) fail(404, 'Space channels are not turned on for you', 'space_channels_off');
    let actor: LinkActor | null = null;
    if (need === 'owner') {
      actor = person(caller);
      if (!canManage(access)) refused({ code: 'not_owner', message: `Only an owner of ${space.name} can link or unlink its channels.` });
      // The fake workspace gives everyone a Slack id; the real store only those signed in to Slack's app.
      const slackId = (await d.store.slackIdsOf([actor.userId])).get(actor.userId);
      if (slackId) actor.slackId = slackId;
    }
    return { d, caller, space, access, actor: actor as LinkActor };
  }

  async function emailsOf(d: ManageDeps, spaceId: string): Promise<Map<string, string>> {
    return new Map((await d.spaces.members(spaceId)).map(m => [m.userId, m.user.email] as const));
  }

  async function statusView(d: ManageDeps, space: SpaceRecord, caller: SpaceCaller, access: SpaceAccess) {
    const row = await d.store.spaceSlack(space.id);
    const enabled = !!row && !row.disabledAt;
    const emails = await emailsOf(d, space.id);
    const who = (userId: string | null) => (userId ? { userId, email: emails.get(userId) ?? null } : null);
    const limits = await d.limitsFor(enabled ? row!.runnerUserId : caller.userId, row?.limits ?? null);
    const box = enabled && row!.instanceId ? await d.spaces.box(row!.instanceId) : null;
    // A disabled space's channels too: ones a disable couldn't unlink stay visible, to unlink (or disable again).
    const channels = row ? await d.admin.linkedChannels(row.id) : [];
    return {
      space: space.name,
      enabled,
      status: enabled ? row!.status : null,
      runner: enabled ? who(row!.runnerUserId) : null,
      // A new small box is provisioned by the orchestrator runner (M7); until then none exists.
      box: enabled ? (box ? { kind: 'existing', id: box.id, name: box.name } : { kind: 'new', size: 'small' }) : null,
      pendingRunner: enabled ? who(await pendingRunnerOf(d, space.id)) : null,
      caps: { channelsPerSpace: limits.channelsPerSpace, allowPrivate: limits.allowPrivate },
      channels: channels.map(c => channelView(c, emails)),
      you: { owner: caller.kind === 'user' && canManage(access), runner: enabled && caller.userId === row!.runnerUserId && caller.kind === 'user' },
      slack: deps.slackMode?.() ?? (d.slack ? 'slack' : 'none'),
    };
  }

  /** `{existing: <box id or name>}` (one of the caller's) or `{new: {size: 'small'}}`; 'new' is short for the latter. */
  async function boxChoice(d: ManageDeps, userId: string, raw: unknown): Promise<RunnerBoxChoice | undefined> {
    if (raw === undefined || raw === null) return undefined;
    if (raw === 'new') return DEFAULT_RUNNER_BOX;
    const r = (raw && typeof raw === 'object' ? raw : {}) as { existing?: unknown; new?: unknown };
    if ('new' in r) {
      // Only a small box exists for now: anything else is refused, never quietly made small.
      const n = r.new as { size?: unknown } | null;
      if (n && typeof n === 'object' && n.size === 'small' && Object.keys(r).length === 1) return DEFAULT_RUNNER_BOX;
    } else if (typeof r.existing === 'string' && Object.keys(r).length === 1) {
      const mine = await d.spaces.boxesOwnedBy(userId);
      const found = mine.find(b => b.id === r.existing) ?? mine.find(b => b.name === r.existing);
      // An unknown box goes through as given, for enable's own runner_no_box.
      return { existing: found?.id ?? r.existing };
    }
    fail(400, 'runner.box is {"existing": "<box>"} or {"new": {"size": "small"}}', 'bad_request');
  }

  function linkInput(req: Request) {
    const b = bodyOf(req);
    const create = b.create as Record<string, unknown> | undefined;
    if (create !== undefined) {
      if (!create || typeof create !== 'object' || typeof create.name !== 'string') fail(400, 'create needs a name', 'bad_request');
      return { create: { name: create.name, private: create.private === true, inviteMembers: create.inviteMembers === true } };
    }
    const raw = typeof b.channelId === 'string' ? b.channelId.trim() : '';
    // `<#C123|name>` as Slack writes a channel reference, or a bare id.
    const channelId = /^<#([A-Z0-9]+)(\|[^>]*)?>$/.exec(raw)?.[1] ?? raw;
    if (!/^[A-Z0-9]{8,}$/.test(channelId)) fail(400, 'channelId is a Slack channel id, like C0123ABCD', 'bad_request');
    return { channelId };
  }

  // ---- the picker ----

  router.get('/slack/channels', handler(async (req, res) => {
    const d = await deps.services();
    const caller = callerOf(req, res);
    const actor = person(caller);
    if (!await d.channelsEnabled(actor.userId)) fail(404, 'Space channels are not turned on for you', 'space_channels_off');
    const owned = (await d.spaces.spacesOfUser(actor.userId)).filter(s => s.role === 'owner');
    if (!owned.length) fail(403, 'Only an owner of a space can link Slack channels', 'not_owner');
    if (!d.slack) fail(503, 'Slack isn\'t configured on this termag', 'slack_not_configured');
    const page = await pickChannels({
      slack: d.slack, store: d.store, admin: d.admin,
      async visibleSpaceName(spaceId, userId) {
        const space = await d.spaces.findSpace(spaceId);
        return space && (await d.spaces.memberRoles(space.id)).has(userId) ? space.name : null;
      },
    }, pickerCache, {
      userId: actor.userId,
      query: typeof req.query.query === 'string' ? req.query.query : undefined,
      cursor: typeof req.query.cursor === 'string' ? req.query.cursor : undefined,
    });
    res.json(page);
  }));

  // ---- status ----

  router.get('/:space/slack', handler(async (req, res) => {
    const { d, space, caller, access } = await load(req, res, 'member');
    res.json(await statusView(d, space, caller, access));
  }));

  // ---- link ----

  /**
   * A channel still linked to a space whose Slack is off: a disable that couldn't unlink it. Preview and
   * commit (onlyIfLinked or not) all refuse it the same way, pointing at the two ways to finish.
   */
  function disableUnfinished(spaceName: string): never {
    fail(409, `Slack is off for ${spaceName}, but this channel is still linked to it: disable ${spaceName} again, or unlink the channel, then link it`, 'disable_unfinished');
  }

  /** termag can't see the channel: a private one it isn't in (conversations.info answers channel_not_found). */
  async function invisibleToTermag(d: ManageDeps & { slack: LinkSlackClient | null }, channelId: string): Promise<boolean> {
    try {
      await d.slack!.conversations.info({ channel: channelId });
      return false;
    } catch (err) {
      return (err as { data?: { error?: string } })?.data?.error === 'channel_not_found';
    }
  }

  async function linkRoute(req: Request, res: Response, mode: 'preview' | 'commit') {
    const { d, space, actor } = await load(req, res, 'owner');
    const target = linkInput(req);
    const runnerBox = await boxChoice(d, actor.userId, (bodyOf(req).runner as { box?: unknown } | undefined)?.box);
    // Before any preview, so a create preview can't succeed where its commit can't.
    if (!d.slack) fail(503, 'Slack isn\'t configured on this termag', 'slack_not_configured');
    // onlyIfLinked: a caller that skipped its confirmation because the preview said "already linked here"
    // (the CLI) sends it. It never goes through link(), so it can never claim the channel: if the
    // channel is still linked here it does what link()'s same-space commit does (repeat the link's
    // freeze of the channel's other threads) and answers already; otherwise it links nothing.
    if (mode === 'commit' && bodyOf(req).onlyIfLinked === true) {
      if (!target.channelId) fail(400, 'onlyIfLinked goes with a channelId', 'bad_request');
      const row = await d.store.channel(target.channelId);
      const ss = row && !row.unlinkedAt ? await d.store.spaceSlackById(row.spaceSlackId) : null;
      if (!row || !ss || ss.spaceId !== space.id) {
        fail(409, `That channel is no longer linked to ${space.name}; link it again to see its preview`, 'not_linked');
      }
      if (ss.disabledAt) disableUnfinished(space.name);
      await (d.freezer ?? noThreadFreezer).freezeAtLink(row.channelId, space.name, (d.now ?? (() => new Date()))(), { repeat: true });
      res.json({ channel: channelView(row, await emailsOf(d, space.id)), already: true, failedInvites: [] });
      return;
    }
    const result = await link(d, { spaceName: space.name, actor, via: deps.via, mode, ...target, ...(runnerBox ? { runner: { box: runnerBox } } : {}) });
    if (result.kind === 'refused') {
      // A private channel termag isn't in answers as any such channel does (needs an invite),
      // whether or not another space has it: its link must not show through to someone outside it.
      if (result.code === 'channel_linked' && target.channelId && await invisibleToTermag(d, target.channelId)) {
        if (mode === 'commit') refused({ code: 'needs_invite', message: '' });
        const ss = await d.store.spaceSlack(space.id);
        res.json({ bystanders: null, needsInvite: true, firstLink: !ss || !!ss.disabledAt, channelName: null, isPrivate: true });
        return;
      }
      refused(result);
    }
    if (result.kind === 'preview') {
      const { kind: _k, ...preview } = result;
      res.json(preview);
      return;
    }
    // Linked here, but on a disabled row (a disable that couldn't unlink it): not a link that succeeded.
    if (result.already && (await d.store.spaceSlackById(result.channel.spaceSlackId))?.disabledAt) disableUnfinished(space.name);
    if (mode === 'preview') {
      // Already linked to this space: still a preview's answer, which says so.
      res.json({
        bystanders: null, needsInvite: false, firstLink: false, channelName: result.channel.name, isPrivate: result.channel.isPrivate,
        alreadyLinked: true,
      });
      return;
    }
    res.status(result.already ? 200 : 201).json({
      channel: channelView(result.channel, await emailsOf(d, space.id)),
      already: result.already,
      failedInvites: result.failedInvites ?? [],
    });
  }

  router.post('/:space/slack/channels/preview', handler((req, res) => linkRoute(req, res, 'preview')));
  router.post('/:space/slack/channels', handler((req, res) => linkRoute(req, res, 'commit')));

  // ---- unlink ----

  async function ownChannel(d: ManageDeps, space: SpaceRecord, channelId: string): Promise<SpaceChannelRow> {
    const row = await d.store.channel(channelId);
    const ss = row && !row.unlinkedAt ? await d.store.spaceSlackById(row.spaceSlackId) : null;
    // A channel linked to another space is not this space's to unlink, nor to name.
    if (!row || !ss || ss.spaceId !== space.id) fail(404, `That channel isn't linked to ${space.name}`, 'not_linked');
    return row;
  }

  router.get('/:space/slack/channels/:channelId', handler(async (req, res) => {
    const { d, space, actor } = await load(req, res, 'owner');
    const row = await ownChannel(d, space, req.params.channelId);
    const result = await unlink(d, { channelId: row.channelId, actor, via: deps.via, reason: 'owner', mode: 'preview' });
    if (result.kind === 'refused') refused(result);
    if (result.kind !== 'preview') fail(500, 'Unexpected unlink result', 'internal');
    res.json({ channel: channelView(row, await emailsOf(d, space.id)), threads: result.threads, canArchive: result.canArchive });
  }));

  router.delete('/:space/slack/channels/:channelId', handler(async (req, res) => {
    const { d, space, actor } = await load(req, res, 'owner');
    const row = await ownChannel(d, space, req.params.channelId);
    const archive = req.query.archive === 'true' || req.query.archive === '1';
    if (archive && !row.createdByTermag) fail(400, 'Only a channel termag created can be archived on unlink', 'cannot_archive');
    const result = await unlink(d, { channelId: row.channelId, actor, via: deps.via, reason: 'owner', archive, mode: 'commit' });
    if (result.kind === 'refused') refused(result);
    if (result.kind !== 'unlinked') fail(500, 'Unexpected unlink result', 'internal');
    res.json({ unlinked: row.channelId, name: row.name, archived: result.archived });
  }));

  // ---- pause, resume, runner, disable ----

  for (const [path, paused] of [['pause', true], ['resume', false]] as const) {
    router.post(`/:space/slack/${path}`, handler(async (req, res) => {
      const { d, space, caller, access, actor } = await load(req, res, 'owner');
      const result = await setPaused(d, { space, actor, via: deps.via }, paused);
      if (result.kind === 'refused') refused(result);
      res.json(await statusView(d, space, caller, access));
    }));
  }

  router.post('/:space/slack/runner', handler(async (req, res) => {
    const { d, space, caller, access, actor } = await load(req, res, 'owner');
    const b = bodyOf(req);
    let request: RunnerRequest;
    if (typeof b.offer === 'string') {
      const target = b.offer.trim().toLowerCase();
      const member = (await d.spaces.members(space.id)).find(m => m.user.email.toLowerCase() === target || m.userId === b.offer);
      if (!member) fail(400, `${b.offer} isn't a member of ${space.name}`, 'not_an_owner');
      request = { offer: member.userId };
    } else if (b.cancel === true) {
      request = { cancel: true };
    } else if (b.accept === true) {
      const box = await boxChoice(d, actor.userId, b.box);
      request = { accept: true, ...(box ? { box } : {}) };
    } else {
      fail(400, 'Send {"offer": "<owner email>"}, {"cancel": true} or {"accept": true, "box": …}', 'bad_request');
    }
    const result = await handOverRunner(d, { space, actor, via: deps.via }, request);
    if (result.kind === 'refused') refused(result);
    res.json(await statusView(d, space, caller, access));
  }));

  router.delete('/:space/slack', handler(async (req, res) => {
    const { d, space, actor } = await load(req, res, 'owner');
    const result = await disable(d, { space, actor, via: deps.via });
    if (result.kind === 'refused') refused(result);
    res.json({ disabled: !result.reenabled, unlinked: result.unlinked, remaining: result.remaining, unfrozen: result.unfrozen, reenabled: result.reenabled });
  }));

  return router;
}
