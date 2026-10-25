/**
 * Browser pane socket: `WS /termag/ws/browser`.
 *
 * The viewer names a project, a workstream and a URL. The handler checks the
 * session, the project (owner or share), the flag for this viewer and box,
 * the box's power state and the agent's capability, then asks the agent for
 * a browser stream and relays: frames and navigation down, input up. Every
 * dependency is injected so the handler is tested against fakes; the default
 * set below is the live one.
 *
 * A reviewer's pane names a preview share instead,
 * `?share=<id>`, and takes the guest path: the share, not the project, is
 * what admits them, its project and workstream come from the share, and the
 * agent is asked for a guest browser kept to the share's app. Nothing on that
 * path admits anyone to the project itself.
 */
import type { Instance, User } from '@prisma/client';
import { prisma } from '../db';
import { boolVariation, buildFlagContext, numberVariationForContext } from '../services/featureFlags';
import { instanceStatus } from '../services/boxPower';
import { TERMINAL_BOX_PARKED_CLOSE_CODE, terminalAttachRefusal } from '../services/boxPowerPolicy';
import {
  closeBrowserStream,
  isProjectAgentConnected,
  projectAgentCapabilities,
  requestBrowserStream,
  requestBrowserSuggestions,
  sendBrowserMessage,
  type BrowserAttachOptions,
  type ProjectHost,
} from '../services/agentRegistry';
import { projectDirUnder, resolveProjectRoot } from '../services/projectPaths';
import {
  BROWSER_PANE_DISABLED_CLOSE_CODE,
  BROWSER_PANE_FLAG,
  BROWSER_PANE_PROFILES_FLAG,
  BROWSER_PANE_RETRY_CLOSE_CODE,
  BROWSER_PANE_UNSUPPORTED_CLOSE_CODE,
  agentSupportsBrowserPane,
  agentSupportsGuests,
  agentSupportsKeptProfiles,
  clampViewport,
  normalizeBrowserUrl,
  parseBrowserClientMessage,
  parseBrowserPaneQuery,
  parseBrowserSuggestions,
  toAgentBrowserMessage,
  type BrowserSuggestion,
} from '../services/browserPane';
import {
  GUEST_REFUSAL_MESSAGES, GUEST_REFUSED_CLOSE_CODE, guestAttachRefusal, guestPaneKey, isShareId, maxGuestPanes, resolveGuestAccess, safeAtPath, shareLiveness,
  type GuestRefusal,
} from '../services/previewShareRules';
import {
  prismaPreviewShareStore, registerGuestSocket, shareTarget, type GuestShareContext, type GuestSocketHandle,
} from '../services/previewShares';

export const PREVIEW_SHARE_FLAG = 'browser-pane-preview-share-enabled';
export const GUEST_KILL_SWITCH = 'browser-pane-guest-kill-switch';
export const GUEST_MAX_FLAG = 'browser-pane-guest-max-concurrent';
/** How often a live guest socket re-checks its grant and the flags: revocation elsewhere, expiry, a kill switch. */
export const GUEST_RECHECK_MS = 30_000;

export interface BrowserPaneProject {
  id: string;
  name: string;
  userId: string;
  /** The owner's unix user: with the box's home, where the project's files live. */
  ownerUnixUsername: string;
  instanceId: string | null;
  setupStatus: string;
  instance: Instance | null;
}

/** The socket as the handler uses it: the `ws` WebSocket, or a fake in tests. `send`'s callback fires once the data has left for the viewer. */
export interface BrowserPaneSocket {
  readyState: number;
  send(data: string, cb?: (err?: Error) => void): void;
  close(code?: number, reason?: string): void;
  on(event: string, listener: (...args: any[]) => void): unknown;
}

export interface BrowserWsDeps {
  findProject(projectId: string): Promise<BrowserPaneProject | null>;
  findUser(userId: string): Promise<User | null>;
  hasShare(projectId: string, userId: string): Promise<boolean>;
  flagOn(viewer: User, box: Instance | null): Promise<boolean>;
  /** browser-pane-persistent-profiles-enabled, for the project's owner and box. */
  keptProfilesOn(owner: User, box: Instance | null): Promise<boolean>;
  boxStatus(instanceId: string | null): Promise<string | null>;
  agentConnected(host: ProjectHost): boolean;
  agentCapabilities(host: ProjectHost): readonly string[];
  requestStream(host: ProjectHost, opts: BrowserAttachOptions, onEvent: (msg: any) => void): Promise<string>;
  sendToStream(streamId: string, msg: Record<string, unknown>): void;
  closeStream(streamId: string): void;
  /** Which web apps listen on the box; `cwd` is the project's directory there, for a dev-stack hint. */
  suggest(host: ProjectHost, cwd: string | null): Promise<BrowserSuggestion[]>;
  log(line: string): void;
  // ── the guest path ──
  /** With `viewerId`, a link share's row for that viewer too. */
  guestContext(shareId: string, viewerId?: string): Promise<GuestShareContext | null>;
  /** The owner-and-box flags a guest pane needs: the pane, sharing, the kill switch, the pool size. */
  guestFlags(owner: User, box: Instance | null): Promise<{ paneOn: boolean; sharingOn: boolean; killed: boolean; maxGuests: number }>;
  registerGuest(shareId: string, handle: GuestSocketHandle): () => void;
  recordShareEvent(shareId: string, kind: string, opts?: { actorId?: string | null; reason?: string | null; detail?: any }): Promise<void>;
  noteShareOpened(shareId: string, viewerId: string): Promise<void>;
  now(): number;
  recheckMs?: number;
}

export const defaultBrowserWsDeps: BrowserWsDeps = {
  async findProject(projectId) {
    const p = await prisma.project.findUnique({ where: { id: projectId }, include: { user: true } });
    if (!p) return null;
    const instance = p.instanceId ? await prisma.instance.findUnique({ where: { id: p.instanceId } }) : null;
    return { id: p.id, name: p.name, userId: p.userId, ownerUnixUsername: p.user.unixUsername, instanceId: p.instanceId, setupStatus: p.setupStatus, instance };
  },
  findUser: (userId) => prisma.user.findUnique({ where: { id: userId } }),
  async hasShare(projectId, userId) {
    const share = await prisma.projectShare.findUnique({ where: { projectId_userId: { projectId, userId } } });
    return share !== null;
  },
  flagOn: (viewer, box) => boolVariation(BROWSER_PANE_FLAG, viewer, false, box),
  keptProfilesOn: (owner, box) => boolVariation(BROWSER_PANE_PROFILES_FLAG, owner, false, box),
  boxStatus: instanceStatus,
  agentConnected: isProjectAgentConnected,
  agentCapabilities: projectAgentCapabilities,
  requestStream: requestBrowserStream,
  sendToStream: sendBrowserMessage,
  closeStream: closeBrowserStream,
  suggest: async (host, cwd) => parseBrowserSuggestions(await requestBrowserSuggestions(host, cwd)),
  log: (line) => console.log(line),
  guestContext: (shareId, viewerId) => prismaPreviewShareStore.guestContext(shareId, viewerId),
  async guestFlags(owner, box) {
    const [paneOn, sharingOn, killed, max] = await Promise.all([
      boolVariation(BROWSER_PANE_FLAG, owner, false, box),
      boolVariation(PREVIEW_SHARE_FLAG, owner, false, box),
      boolVariation(GUEST_KILL_SWITCH, owner, false, box),
      numberVariationForContext(GUEST_MAX_FLAG, buildFlagContext(owner, box), 5),
    ]);
    return { paneOn, sharingOn, killed, maxGuests: maxGuestPanes(max) };
  },
  registerGuest: registerGuestSocket,
  recordShareEvent: (shareId, kind, opts) => prismaPreviewShareStore.recordEvent(shareId, kind, opts),
  noteShareOpened: (shareId, viewerId) => prismaPreviewShareStore.noteOpened(shareId, viewerId),
  now: () => Date.now(),
};

const WS_OPEN = 1;
// A guest pane told to redial (its share's recipe changed): 1012 "service restart", not final.
const GUEST_RECONNECT_CLOSE_CODE = 1012;
// Input a viewer sends while Chromium starts (about a second) is kept, not
// dropped: this many frames wait for the stream, oldest first.
const PRE_ATTACH_QUEUE = 64;
// A suggestion scan is up to fifty HTTP probes on the box: one runs at a
// time, and a repeat inside this window gets the last answer again.
const SUGGEST_REUSE_MS = 3000;

export const BROWSER_PANE_DISABLED_MESSAGE = 'The browser pane is off for this box (browser-pane-enabled).';
export const BROWSER_PANE_UNSUPPORTED_MESSAGE = "This box's agent needs an update before it can run a browser pane.";

export async function handleBrowserPaneSocket(
  ws: BrowserPaneSocket,
  url: URL,
  loggedInUserId: string | null,
  deps: BrowserWsDeps = defaultBrowserWsDeps,
): Promise<void> {
  // A refusal the pane can show: the message rides an `exit` frame ahead of the close.
  const refuse = (code: number, reason: string, message?: string) => {
    if (message && ws.readyState === WS_OPEN) ws.send(JSON.stringify({ type: 'exit', reason: message }));
    ws.close(code, reason);
  };

  if (!loggedInUserId) { refuse(1008, 'login required'); return; }
  if (url.searchParams.has('share')) { await handleGuestSocket(ws, url, loggedInUserId, deps, refuse); return; }
  const request = parseBrowserPaneQuery(url.searchParams);
  if ('error' in request) { refuse(1008, request.error); return; }

  const project = await deps.findProject(request.projectId);
  if (!project) { refuse(1008, 'unknown project'); return; }
  const viewer = await deps.findUser(loggedInUserId);
  if (!viewer) { refuse(1008, 'unknown user'); return; }
  if (project.userId !== viewer.id && !(await deps.hasShare(project.id, viewer.id))) {
    deps.log(`[BROWSER-PANE] user ${viewer.id} refused for project ${project.id}`);
    refuse(1008, 'project forbidden');
    return;
  }
  if (!(await deps.flagOn(viewer, project.instance))) {
    refuse(BROWSER_PANE_DISABLED_CLOSE_CODE, 'browser pane disabled', BROWSER_PANE_DISABLED_MESSAGE);
    return;
  }

  const host: ProjectHost = { userId: project.userId, instanceId: project.instanceId };
  const refusal = terminalAttachRefusal(project.instanceId, await deps.boxStatus(project.instanceId), deps.agentConnected(host), project);
  if (refusal?.kind === 'parked') {
    refuse(TERMINAL_BOX_PARKED_CLOSE_CODE, `box ${refusal.notice.status}`, refusal.notice.message);
    return;
  }
  if (refusal?.kind === 'setup') {
    refuse(1008, `project setup ${refusal.refusal.setupStatus}`, refusal.refusal.message);
    return;
  }
  if (refusal) {
    // Not final: the agent reconnects by itself, and may still hold this
    // viewer's parked browser, so the pane keeps redialing for a while.
    refuse(BROWSER_PANE_RETRY_CLOSE_CODE, 'agent not connected', 'Agent not connected for this box.');
    return;
  }
  if (!agentSupportsBrowserPane(deps.agentCapabilities(host))) {
    refuse(BROWSER_PANE_UNSUPPORTED_CLOSE_CODE, 'browser pane unsupported', BROWSER_PANE_UNSUPPORTED_MESSAGE);
    return;
  }

  const where = project.instanceId ? `box ${project.instanceId}` : 'legacy agent';
  deps.log(`[BROWSER-PANE] user ${viewer.id} opens ${request.url} for project ${project.id}/${request.workstream} via ${where} (${request.width}x${request.height})`);
  // The agent parks a closed pane's browser under this key for a while and
  // hands it back, page and all, to the next attach that carries it: a
  // reconnect or a reopened dock lands where the viewer left off.
  const paneKey = `${viewer.id}:${project.id}/${request.workstream}`;
  // A kept profile: the owner's flag decides, for
  // every viewer of the project, and only an agent that keeps profiles is asked.
  const capabilities = deps.agentCapabilities(host);
  const keptProfiles = agentSupportsKeptProfiles(capabilities);
  const owner = project.userId === viewer.id ? viewer : await deps.findUser(project.userId);
  const persistProfile = keptProfiles && !!owner && await deps.keptProfilesOn(owner, project.instance);
  // Where the project's files live on the box, for the suggestion scan's dev-stack hint.
  const cwd = projectDirUnder(resolveProjectRoot({ ownerUnixUser: project.ownerUnixUsername, hostHome: project.instance?.hostHome }), project.name, request.workstream);
  const openShare = await ownSharePage(deps, url, project.id, request.workstream);
  await relayBrowserStream(ws, deps, refuse, {
    host, projectId: project.id, cwd, keptProfiles, guest: false,
    attach: {
      url: request.url, width: request.width, height: request.height, paneKey,
      ...(persistProfile ? { persistProfile: true } : {}),
      ...(url.searchParams.get('dialogs') === '1' ? { relayDialogs: true } : {}),
      ...(openShare ? { openRecipe: openShare.recipe, cwd, ...(openShare.at ? { atPath: openShare.at } : {}) } : {}),
    },
  });
}

/**
 * A share link its owner (or a collaborator) opened: `openShare=<id>[&at=]`
 * on their own pane's first dial. A live share of this project and
 * workstream hands its recipe to the agent, which opens the page on the
 * share's app rather than on whatever app the dock showed last; anything
 * else (another project's, a revoked, ended or expired share) is ignored,
 * and the pane opens as it would have.
 */
async function ownSharePage(deps: BrowserWsDeps, url: URL, projectId: string, workstream: string): Promise<{ recipe: unknown; at: string | null } | null> {
  const shareId = url.searchParams.get('openShare');
  if (!isShareId(shareId)) return null;
  const ctx = await deps.guestContext(shareId).catch(() => null);
  if (!ctx || ctx.project.id !== projectId || (ctx.workstream?.name ?? 'main') !== workstream) return null;
  if (!shareLiveness({ share: ctx.share, workstream: ctx.workstream, projectArchived: ctx.project.archived, now: deps.now() }).ok) return null;
  return { recipe: ctx.share.originRecipe, at: safeAtPath(url.searchParams.get('at')) };
}

type Refuse = (code: number, reason: string, message?: string) => void;

/**
 * A reviewer's pane: `?share=<id>[&url=][&at=][&as=guest]`. Only a live
 * share for this viewer admits them (services/previewShareRules.ts
 * resolveGuestAccess), and they get a guest browser: the agent's guest mode,
 * kept to the share's origins. The owner can open their own share the same
 * way with `as=guest` ("Preview as guest"), to see what the reviewer sees.
 */
async function handleGuestSocket(ws: BrowserPaneSocket, url: URL, viewerId: string, deps: BrowserWsDeps, refuse: Refuse): Promise<void> {
  const shareId = url.searchParams.get('share') ?? '';
  const notShared = () => refuse(GUEST_REFUSED_CLOSE_CODE, 'not-shared', GUEST_REFUSAL_MESSAGES['not-shared']);
  if (!isShareId(shareId)) { notShared(); return; }
  const viewer = await deps.findUser(viewerId);
  if (!viewer) { refuse(1008, 'unknown user'); return; }

  // The grant, the share's state and the flags, as one check: at the attach,
  // and again every GUEST_RECHECK_MS while the socket lives.
  const check = async (): Promise<{ ok: true; ctx: GuestShareContext; maxGuests: number; previewing: boolean } | { ok: false; code: number; reason: string; message: string }> => {
    const ctx = await deps.guestContext(shareId, viewer.id);
    if (!ctx) return { ok: false, code: GUEST_REFUSED_CLOSE_CODE, reason: 'not-shared', message: GUEST_REFUSAL_MESSAGES['not-shared'] };
    const previewing = url.searchParams.get('as') === 'guest' && ctx.share.ownerId === viewer.id;
    const facts = { share: ctx.share, workstream: ctx.workstream, projectArchived: ctx.project.archived, now: deps.now() };
    const access = previewing ? shareLiveness(facts) : resolveGuestAccess({ ...facts, viewerId: viewer.id, viewerRow: ctx.viewerRow });
    if (!access.ok) {
      const reason: GuestRefusal = access.toGrantee ? access.reason : 'not-shared';
      return { ok: false, code: GUEST_REFUSED_CLOSE_CODE, reason, message: GUEST_REFUSAL_MESSAGES[reason] };
    }
    const flags = await deps.guestFlags(ctx.owner, ctx.project.instance);
    if (flags.killed) return { ok: false, code: BROWSER_PANE_DISABLED_CLOSE_CODE, reason: 'guests off', message: 'Reviewer browsers are switched off right now.' };
    if (!flags.paneOn || !flags.sharingOn) return { ok: false, code: BROWSER_PANE_DISABLED_CLOSE_CODE, reason: 'preview sharing off', message: 'Preview sharing is off for this box.' };
    return { ok: true, ctx, maxGuests: flags.maxGuests, previewing };
  };

  const first = await check();
  if (!first.ok) {
    if (first.reason !== 'not-shared' && first.code === GUEST_REFUSED_CLOSE_CODE) await deps.recordShareEvent(shareId, 'refused', { actorId: viewer.id, reason: first.reason });
    deps.log(`[BROWSER-PANE] guest ${viewer.id} refused for share ${shareId}: ${first.reason}`);
    refuse(first.code, first.reason, first.message);
    return;
  }
  const { ctx, maxGuests, previewing } = first;
  const project = ctx.project;
  // Seam 1: the box, checkout and recipe come from the share's target, not its fields.
  const target = shareTarget(ctx);
  if (!target) { refuse(GUEST_REFUSED_CLOSE_CODE, 'workstream-gone', GUEST_REFUSAL_MESSAGES['workstream-gone']); return; }
  const host: ProjectHost = target.host;
  const refusal = terminalAttachRefusal(project.instanceId, await deps.boxStatus(project.instanceId), deps.agentConnected(host), project);
  if (refusal?.kind === 'parked') {
    // A guest never wakes a box (phase 1): the page offers to ask the owner.
    await deps.recordShareEvent(shareId, 'refused', { actorId: viewer.id, reason: 'box-asleep' });
    refuse(TERMINAL_BOX_PARKED_CLOSE_CODE, 'box asleep', `${ctx.owner.displayName}'s box is asleep.`);
    return;
  }
  if (refusal?.kind === 'setup') {
    refuse(1008, `project setup ${refusal.refusal.setupStatus}`, "The owner's project is still being set up.");
    return;
  }
  if (refusal) {
    refuse(BROWSER_PANE_RETRY_CLOSE_CODE, 'agent not connected', "The owner's box isn't connected right now.");
    return;
  }
  const capabilities = deps.agentCapabilities(host);
  if (!agentSupportsBrowserPane(capabilities) || !agentSupportsGuests(capabilities)) {
    refuse(BROWSER_PANE_UNSUPPORTED_CLOSE_CODE, 'guest pane unsupported', "The owner's box can't run a reviewer's browser yet (it needs an update).");
    return;
  }

  const workstream = target.workstream;
  const keptProfiles = agentSupportsKeptProfiles(capabilities);
  const persistProfile = keptProfiles && await deps.keptProfilesOn(ctx.owner, project.instance);
  const cwd = target.cwd;
  const viewport = clampViewport(url.searchParams.get('width'), url.searchParams.get('height'));
  const requested = url.searchParams.get('url');
  const startUrl = requested ? normalizeBrowserUrl(requested) : 'about:blank';
  if (!startUrl) { refuse(1008, 'url must be http or https'); return; }
  const at = safeAtPath(url.searchParams.get('at'));
  deps.log(`[BROWSER-PANE] guest ${viewer.id} opens share ${shareId} (${project.id}/${workstream})${previewing ? ' as the owner, previewing' : ''}`);

  let rechecks: ReturnType<typeof setInterval> | null = null;
  let expiry: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  const end = (code: number, reason: string, message: string) => {
    if (ws.readyState === WS_OPEN) refuse(code, reason, message);
  };
  // Registered before the attach: a revoke while the browser starts closes
  // this socket too (the relay then closes the stream it gets).
  // A share renewed with another recipe: not an end, a redial (1012 is not
  // final for the pane), which attaches with the share's origins as they are now.
  const reconnect = () => { if (ws.readyState === WS_OPEN) ws.close(GUEST_RECONNECT_CLOSE_CODE, 'share updated'); };
  const attachedRecipe = JSON.stringify(target.recipe);
  const unregister = deps.registerGuest(shareId, { viewerId: viewer.id, close: (message) => end(GUEST_REFUSED_CLOSE_CODE, 'share ended', message), reconnect });
  ws.on('close', () => {
    closed = true;
    if (rechecks) clearInterval(rechecks);
    if (expiry) clearTimeout(expiry);
    unregister();
  });

  const opened = await relayBrowserStream(ws, deps, refuse, {
    host, projectId: project.id, cwd: null, keptProfiles, guest: true, shareId,
    attach: {
      url: startUrl, width: viewport.width, height: viewport.height, paneKey: guestPaneKey(shareId, viewer.id),
      mode: 'guest', recipe: target.recipe, cwd, maxGuestPanes: maxGuests,
      profileExpiresAt: ctx.share.expiresAt.toISOString(),
      ...(at ? { atPath: at } : {}),
      ...(url.searchParams.get('dialogs') === '1' ? { relayDialogs: true } : {}),
      ...(persistProfile ? { persistProfile: true } : {}),
    },
  });
  if (!opened || ws.readyState !== WS_OPEN) return;
  if (!previewing) await deps.noteShareOpened(shareId, viewer.id);
  if (closed || ws.readyState !== WS_OPEN) return;

  // Revoked here: closed at once (registered above). Revoked on another
  // orchestrator, expired, a flag flipped, the workstream gone: closed at
  // the next re-check.
  const recheck = async () => {
    const again = await check().catch(() => null);
    if (again && !again.ok) {
      deps.log(`[BROWSER-PANE] guest ${viewer.id} on share ${shareId} closed: ${again.reason}`);
      end(again.code, again.reason, again.message);
    } else if (again && again.ok && JSON.stringify(shareTarget(again.ctx)?.recipe) !== attachedRecipe) {
      deps.log(`[BROWSER-PANE] guest ${viewer.id} on share ${shareId}: its recipe changed, redialing`);
      reconnect();
    }
  };
  rechecks = setInterval(recheck, deps.recheckMs ?? GUEST_RECHECK_MS);
  const untilExpiry = ctx.share.expiresAt.getTime() - deps.now();
  if (untilExpiry < 2 ** 31 - 1) expiry = setTimeout(recheck, Math.max(0, untilExpiry) + 50);
}

interface RelayOptions {
  host: ProjectHost;
  projectId: string;
  /** The project's directory on the box, for the suggestion scan; null where suggestions are off (guests). */
  cwd: string | null;
  keptProfiles: boolean;
  guest: boolean;
  shareId?: string;
  attach: BrowserAttachOptions;
}

/**
 * The relay half, owner's and guest's alike: ask the agent for the stream,
 * then frames and navigation down, input up. A guest gets no suggestions
 * (they would list the box's ports), and the guest's events (blocked
 * addresses, the checkout) are relayed too. Resolves whether the stream
 * opened.
 */
async function relayBrowserStream(ws: BrowserPaneSocket, deps: BrowserWsDeps, refuse: Refuse, opts: RelayOptions): Promise<boolean> {
  const { host, projectId, cwd, keptProfiles, guest } = opts;
  let scanning = false;
  let lastScan: { at: number; items: BrowserSuggestion[] } | null = null;
  const answerSuggestions = () => {
    if (scanning || cwd === null) return;
    if (lastScan && Date.now() - lastScan.at < SUGGEST_REUSE_MS) {
      ws.send(JSON.stringify({ type: 'suggestions', items: lastScan.items }));
      return;
    }
    scanning = true;
    deps.suggest(host, cwd)
      .catch((err) => { deps.log(`[BROWSER-PANE] suggestions failed for project ${projectId}: ${(err as Error).message}`); return [] as BrowserSuggestion[]; })
      .then((items) => {
        scanning = false;
        lastScan = { at: Date.now(), items };
        if (ws.readyState === WS_OPEN) ws.send(JSON.stringify({ type: 'suggestions', items }));
      });
  };

  // Listen before the attach: a frame that arrives while the browser starts
  // would otherwise be emitted with nobody reading it. Queued frames flush the
  // moment the stream exists; a close in that window is remembered.
  let streamId: string | null = null;
  let closedBeforeAttach = false;
  const pending: Record<string, unknown>[] = [];
  ws.on('message', (raw: { toString(): string }) => {
    const msg = parseBrowserClientMessage(raw.toString());
    if (!msg) return;
    // Suggestions need no stream: the scan runs on the box whatever the browser is doing.
    if (msg.type === 'suggest') { if (!guest) answerSuggestions(); return; }
    // An agent without kept profiles has nothing to reset, and a reviewer's
    // kept profile is the share's to forget, not theirs.
    if (msg.type === 'reset-profile' && (!keptProfiles || guest)) return;
    const out = toAgentBrowserMessage(msg);
    if (streamId) deps.sendToStream(streamId, out);
    else if (pending.length < PRE_ATTACH_QUEUE) pending.push(out);
  });
  ws.on('close', () => {
    if (streamId) deps.closeStream(streamId);
    else closedBeforeAttach = true;
  });

  const reportedBlocked = new Set<string>();
  let attached: string;
  try {
    attached = await deps.requestStream(host, opts.attach, (msg) => {
      if (ws.readyState !== WS_OPEN) return;
      switch (msg.type) {
        case 'browser-frame': {
          // The ack goes back once the frame has left for the viewer, so Chromium
          // paints at the pace the viewer's link can carry (the agent holds the
          // next frame until then), not as fast as the box can send. The frame
          // names its stream: the first one can land while the attach is still
          // resolving, and it is acked like any other.
          const sid = typeof msg.streamId === 'string' ? msg.streamId : streamId;
          ws.send(JSON.stringify({ type: 'frame', data: msg.data, width: msg.width, height: msg.height }), () => {
            if (sid) deps.sendToStream(sid, { type: 'browser-frame-ack' });
          });
          break;
        }
        case 'browser-nav':
          ws.send(JSON.stringify({ type: 'nav', url: msg.url ?? '', title: msg.title ?? '', canGoBack: !!msg.canGoBack, canGoForward: !!msg.canGoForward }));
          break;
        case 'browser-exit':
          ws.send(JSON.stringify({ type: 'exit', reason: typeof msg.reason === 'string' ? msg.reason : 'browser exited' }));
          // Taken over by a newer attach on the same kept profile (another
          // tab): a final close, so this pane shows why and doesn't redial
          // and take it back.
          if (msg.takenOver === true) ws.close(1008, 'taken over');
          else ws.close(1000, 'browser exited');
          break;
        case 'browser-blocked': {
          if (!guest || typeof msg.origin !== 'string') break;
          const origin = msg.origin.slice(0, 200);
          const local = msg.local === true;
          ws.send(JSON.stringify({ type: 'blocked', origin, local }));
          // A loopback address the share is missing is the owner's to add: recorded once per socket.
          if (local && opts.shareId && !reportedBlocked.has(origin)) {
            reportedBlocked.add(origin);
            deps.recordShareEvent(opts.shareId, 'blocked-origin', { detail: { origin } }).catch(() => {});
          }
          break;
        }
        // A page's alert, confirm or prompt for the viewer to answer, and its
        // end (answered, timed out, or gone with its page). Only a pane that
        // asked (dialogs=1) is sent these.
        case 'browser-dialog':
          if (typeof msg.id !== 'number') break;
          ws.send(JSON.stringify({
            type: 'dialog', id: msg.id,
            kind: ['alert', 'confirm', 'prompt'].includes(msg.kind) ? msg.kind : 'alert',
            message: typeof msg.message === 'string' ? msg.message.slice(0, 2000) : '',
            ...(typeof msg.defaultPrompt === 'string' ? { defaultPrompt: msg.defaultPrompt.slice(0, 2000) } : {}),
          }));
          break;
        case 'browser-dialog-closed':
          if (typeof msg.id === 'number') ws.send(JSON.stringify({ type: 'dialog-closed', id: msg.id }));
          break;
        case 'browser-checkout':
          if (!guest) break;
          ws.send(JSON.stringify({
            type: 'checkout',
            branch: typeof msg.branch === 'string' ? msg.branch.slice(0, 200) : '',
            head: typeof msg.head === 'string' ? msg.head.slice(0, 64) : '',
            dirty: typeof msg.dirty === 'number' ? msg.dirty : null,
          }));
          break;
        default:
          break;
      }
    });
  } catch (err) {
    const message = (err as Error).message;
    deps.log(`[BROWSER-PANE] attach failed for project ${projectId}: ${message}`);
    if (guest) {
      const mapped = guestAttachRefusal(message);
      if (opts.shareId) deps.recordShareEvent(opts.shareId, 'refused', { reason: message.slice(0, 120) }).catch(() => {});
      refuse(mapped.code, mapped.retry ? 'busy' : 'agent refused', mapped.message);
    } else {
      refuse(1011, 'agent error', `Could not start a browser on the box: ${message}`);
    }
    return false;
  }

  // A viewer that left during the attach fired 'close' before the stream had
  // an id, so the close listener above could not tell the agent; do it here.
  if (closedBeforeAttach || ws.readyState !== WS_OPEN) {
    deps.closeStream(attached);
    return false;
  }
  streamId = attached;
  for (const out of pending.splice(0)) deps.sendToStream(streamId, out);
  // The pane shows the page only from here: before this the browser was starting.
  ws.send(JSON.stringify({ type: 'ready' }));
  return true;
}
