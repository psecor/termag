/**
 * Slack Event Handlers
 *
 * Handles @mentions, DMs, and /t commands.
 * DMs/mentions → executor (spawns claude with stream-json)
 * /t commands → tmux (send-keys + capture-pane)
 */

// App type used loosely — Bolt's CJS export doesn't play well with TS imports
type App = any;
import { prisma } from '../db';

import { executeClaudeCommand, resolveWorkingDir } from './executor';
import { StreamingMessageUpdater } from './streaming';
import { formatError, formatWelcome } from './formatting';
import { publishHomeView } from './homeView';
import { resolveTermagUser } from './userMapping';
import { slackChatAllowed, slackProjectAccess, slackRefusalText, slackUserRefusal, type SlackProjectAccess } from './access';
import { clearActiveTarget, getActiveTarget, guessActiveTarget, setActiveTarget, type ChatPlatform } from './activeTargets';
import { handleCollabThreadMessage } from './collab';
import { slackHandoff } from './handoffCommand';
import { parseSlashCommand, slashHelp } from './slashCommand';
import { ensureMainWorkstream } from '../services/workstreams';
import { sessionName, projectDir, formatPaneForSlack } from '../services/tmux';
import { isAmbiguousSession, operationScopeForResolvedSession, resolveSessionProject } from '../services/sessionResolver';
import { matchChannelTarget, createProjectChannel } from './channels';
import type { Prisma, Project, User } from '@prisma/client';
// tmux ops route through the per-user agent (the backend can't see the user's
// tmux in-process). Same signatures as the old ../services/tmux helpers.
import {
  hasSession, sendKeys, capturePaneForSlack, pollUntilStable, listSessionsViaAgent,
} from './tmuxAgent';
import { connectedOwnedBoxIds, isAgentConnected, sendToAgent, type ProjectHost } from '../services/agentRegistry';
import { ensureAgentSessionsAndLaunch } from '../services/agentRuntime';
import { isAdminUser } from '../services/admin/adminAccess';
import {
  registerLocalSession, queueLocalCommand, isLocalSession,
  removeLocalSession, listLocalSessions, updateLocalSessionMessage,
  setActiveLocalSession, getActiveLocalSession, clearActiveLocalSession,
  setNotificationTarget,
} from './lts';

// Track users who have the App Home tab open
const activeHomeViewers = new Set<string>();
export function getActiveHomeViewers() { return activeHomeViewers; }

// In-memory: userId → session message count (for --continue)
const sessionMessageCount = new Map<string, number>();

// ── Emoji reaction → terminal command system ─────────────────
// Maps Slack emoji names to keystrokes sent to the terminal
const EMOJI_KEYS: Record<string, { keys: string; withEnter: boolean }> = {
  one:   { keys: '1', withEnter: false },
  two:   { keys: '2', withEnter: false },
  three: { keys: '3', withEnter: false },
  four:  { keys: '4', withEnter: false },
  five:  { keys: '5', withEnter: false },
  white_check_mark: { keys: 'y', withEnter: true },
  x:     { keys: 'n', withEnter: true },
  leftwards_arrow_with_hook: { keys: '', withEnter: true },
  arrows_counterclockwise: { keys: '', withEnter: false }, // refresh only
};

const NUMBER_EMOJIS = ['one', 'two', 'three', 'four', 'five'];

// Track pane messages so reactions can route to the right session
// Key: "channelId:messageTs" → session info
interface ReactionTarget {
  sessionName: string;
  userId: string;
  channelId: string;
  instanceId?: string | null;
  expiresAt: number;
}
const reactionTargets = new Map<string, ReactionTarget>();
const REACTION_TTL = 60 * 60 * 1000; // 1 hour

export function trackPaneMessage(
  channelId: string,
  messageTs: string,
  tmuxSession: string,
  userId: string,
  instanceId?: string | null,
): void {
  const now = Date.now();
  for (const [key, val] of reactionTargets) {
    if (val.expiresAt < now) reactionTargets.delete(key);
  }
  reactionTargets.set(`${channelId}:${messageTs}`, {
    sessionName: tmuxSession,
    userId,
    channelId,
    instanceId,
    expiresAt: now + REACTION_TTL,
  });
}

export function trackedPaneInstance(channelId: string, messageTs: string): string | null | undefined {
  return reactionTargets.get(`${channelId}:${messageTs}`)?.instanceId;
}

// Detect numbered prompts in pane content (e.g. "  1. Allow once")
function detectNumberedPrompts(paneContent: string): number {
  const lines = paneContent.split('\n').slice(-15); // check last 15 lines
  let maxNum = 0;
  for (const line of lines) {
    const match = line.match(/^\s*(\d+)[\.\)]\s/);
    if (match) {
      const n = parseInt(match[1], 10);
      if (n > 0 && n <= 5) maxNum = Math.max(maxNum, n);
    }
  }
  return maxNum;
}

// Add hint emojis to a pane message if numbered prompts are detected
export async function addReactionHints(client: any, channelId: string, messageTs: string, paneContent: string): Promise<void> {
  const count = detectNumberedPrompts(paneContent);
  if (count === 0) return;
  for (let i = 0; i < count; i++) {
    try {
      await client.reactions.add({ channel: channelId, timestamp: messageTs, name: NUMBER_EMOJIS[i] });
    } catch { /* ignore — may already have the reaction */ }
  }
}

// Rate limiting
const userLastRequest = new Map<string, number>();
const RATE_LIMIT_MS = (parseInt(process.env.RATE_LIMIT_SECONDS ?? '2', 10)) * 1000;

function isRateLimited(userId: string): boolean {
  const now = Date.now();
  if (now - (userLastRequest.get(userId) ?? 0) < RATE_LIMIT_MS) return true;
  userLastRequest.set(userId, now);
  return false;
}

// The active target: what /t drives in DMs and non-project channels, where
// there is no channel to route by. Saved across deploys (activeTargets.ts).
export function getActiveProjectId(userId: string): string | null {
  return getActiveTarget(userId)?.projectId ?? null;
}

export function getActiveWorkstream(userId: string): string {
  return getActiveTarget(userId)?.workstream ?? 'main';
}

/** A first /t's fallback target: not the person's choice, so not saved (activeTargets.ts). */
export function guessActiveProjectId(userId: string, projectId: string): void {
  guessActiveTarget(userId, { projectId, workstream: 'main' });
}

/** Set the active target. Omitting `workstream` resets it to `main`. */
export function setActiveProjectId(userId: string, projectId: string, workstream: string = 'main', platform: ChatPlatform = 'slack'): void {
  setActiveTarget(platform, userId, { projectId, workstream });
}

type ChannelTarget = { project: Project & { user: User }; workstream: string };

/**
 * Map a Slack channel → (project, workstream).
 *
 * Primary: a saved slackChannelId on a Workstream (non-main) or on the Project
 * (main). Fallback: rebuild the canonical `#proj-<user>-<project>[-<ws>]`
 * name for every live tuple and compare (never parses dashes), then the legacy
 * `#proj-<project>` form preferring the invoking user's project. On a name
 * match the id is backfilled so it's a one-time self-heal — covers channels
 * created by hand or before Slack was enabled. Only for a project the caller
 * may reach: a channel named after someone else's project must not become
 * that project's channel.
 */
async function resolveChannelTarget(command: any, preferUserId: string | undefined, access: SlackProjectAccess): Promise<ChannelTarget | null> {
  const byWs = await prisma.workstream.findFirst({
    where: { slackChannelId: command.channel_id, archived: false, project: { archived: false } },
    include: { project: { include: { user: true } } },
  });
  if (byWs) return { project: byWs.project, workstream: byWs.name };

  const byId = await prisma.project.findFirst({
    where: { slackChannelId: command.channel_id, archived: false },
    include: { user: true },
  });
  if (byId) return { project: byId, workstream: 'main' };

  const channelName: string = command.channel_name ?? '';
  if (!channelName.startsWith('proj-')) return null;

  const projects = await prisma.project.findMany({
    where: { archived: false },
    include: { user: true, workstreams: { where: { archived: false }, select: { name: true } } },
  });
  const m = matchChannelTarget(channelName, projects, preferUserId);
  if (!m) return null;
  const project = projects.find(p => p.id === m.projectId)!;
  if (!(await access.mayReach(project.id))) return { project, workstream: m.workstream };

  // Persist the link so future lookups hit the fast path.
  try {
    if (m.workstream === 'main') {
      await prisma.project.update({ where: { id: project.id }, data: { slackChannelId: command.channel_id } });
    } else {
      await prisma.workstream.update({
        where: { projectId_name: { projectId: project.id, name: m.workstream } },
        data: { slackChannelId: command.channel_id },
      });
    }
  } catch { /* race / constraint — non-fatal, routing still works this time */ }
  return { project, workstream: m.workstream };
}

/**
 * `/t ls`: the tmux sessions on each of the caller's boxes with a live agent,
 * by box name, then their legacy per-user agent's. Hosts without sessions are
 * left out.
 */
async function sessionsByHost(userId: string): Promise<{ label: string; sessions: string[] }[]> {
  const boxes = await prisma.instance.findMany({
    where: { id: { in: connectedOwnedBoxIds(userId) } },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  });
  const hosts: { label: string; host: ProjectHost }[] = boxes.map(b => ({ label: b.name, host: { userId, instanceId: b.id } }));
  if (isAgentConnected(userId)) hosts.push({ label: 'per-user agent', host: { userId, instanceId: null } });
  const listed = await Promise.all(hosts.map(async h => ({ label: h.label, sessions: await listSessionsViaAgent(h.host) })));
  return listed.filter(h => h.sessions.length > 0);
}

/** Active (DM) target as a ChannelTarget, or null (also once its project is archived or deleted). */
async function activeTarget(userId: string): Promise<ChannelTarget | null> {
  const projectId = getActiveProjectId(userId);
  if (!projectId) return null;
  const project = await prisma.project.findUnique({ where: { id: projectId }, include: { user: true } });
  return project && !project.archived ? { project, workstream: getActiveWorkstream(userId) } : null;
}

/**
 * What a `/t` drives: the channel's target, else the caller's active one.
 * 'refused' when that is a project the caller may not reach (access.ts), so
 * someone else's project channel is refused rather than falling back to the
 * caller's own target.
 */
async function slashTarget(command: any, userId: string, preferUserId: string | undefined, access: SlackProjectAccess): Promise<ChannelTarget | 'refused' | null> {
  const target = await resolveChannelTarget(command, preferUserId, access) ?? await activeTarget(userId);
  if (!target) return null;
  return (await access.mayReach(target.project.id)) ? target : 'refused';
}

const NOT_YOURS = 'That project is not yours or shared with you.';
const CHAT_OPERATORS_ONLY = 'Chat runs on the termag server itself, so for now it is only for the bot\'s operators. '
  + '`/t` reaches your own projects: run it in a project\'s channel, or `/t switch <project>` here first. `/t help` lists the commands.';

/**
 * For a command word that took the caller's words as its argument and found
 * nothing (`/t switch branches`): how to type them into the agent instead.
 */
function typeInstead(userCommand: string): string {
  return `\n_To type \`${userCommand}\` into the agent instead: \`/t -- ${userCommand}\`_`;
}

/** The reply to a `/t` that threw. Slack's own refusals say why; anything else is in the server log. */
function slashFailureText(error: unknown): string {
  const code = (error as { data?: { error?: unknown } } | null)?.data?.error;
  if (code === 'channel_not_found' || code === 'not_in_channel') {
    return 'termag can\'t post in this conversation. Run `/t` in a project channel or in your DM with termag, or add termag here.';
  }
  return `\`/t\` failed${typeof code === 'string' ? ` (Slack said \`${code}\`)` : ''}. The details are in the termag server's log.`;
}

/**
 * Process a DM or @mention — route to executor (clean Claude response)
 */
async function processMessage(opts: {
  userId: string;
  channelId: string;
  /** A DM with the bot (message.im); otherwise an @mention in a channel. */
  inDM: boolean;
  text: string;
  botUserId?: string | null;
  say: (args: Record<string, unknown>) => Promise<{ ts: string }>;
  client: {
    chat: {
      update: (a: Record<string, unknown>) => Promise<unknown>;
      postMessage: (a: Record<string, unknown>) => Promise<{ ts: string }>;
      postEphemeral: (a: Record<string, unknown>) => Promise<unknown>;
    };
    reactions: { add: (a: Record<string, unknown>) => Promise<unknown>; remove: (a: Record<string, unknown>) => Promise<unknown> };
  };
  threadTs: string;
  messageTs: string;
}): Promise<void> {
  const { userId, channelId, inDM, text, botUserId, say, client, threadTs, messageTs } = opts;
  // Seen only by the sender: any reply in a DM, an ephemeral one in a channel
  // (in the mention's thread when it was in one).
  const replyPrivately = (reply: string) => (inDM
    ? say({ text: reply, thread_ts: threadTs })
    : client.chat.postEphemeral({ channel: channelId, user: userId, text: reply, ...(threadTs !== messageTs ? { thread_ts: threadTs } : {}) }));

  const refusal = await slackUserRefusal(userId, client as unknown as import('@slack/web-api').WebClient);
  if (refusal) {
    // Rate-limited like any message, so repeating it doesn't repeat the reply.
    if (!isRateLimited(userId)) await replyPrivately(slackRefusalText(refusal));
    return;
  }
  if (isRateLimited(userId)) {
    await replyPrivately('⏳ Please wait a moment.');
    return;
  }
  if (!slackChatAllowed(userId)) {
    await replyPrivately(CHAT_OPERATORS_ONLY);
    return;
  }

  // Strip @mention
  const message = botUserId
    ? text.replace(new RegExp(`<@${botUserId}>\\s*`, 'g'), '').trim()
    : text;

  if (!message) {
    await say({ text: formatWelcome(), thread_ts: threadTs });
    return;
  }

  const lower = message.toLowerCase().trim();

  // Special commands
  if (lower === 'new session' || lower === 'reset' || lower === 'clear') {
    sessionMessageCount.set(userId, 0);
    await say({ text: '🔄 *Session cleared!* Starting fresh.', thread_ts: threadTs });
    return;
  }
  if (lower === 'help' || lower === '?') {
    await say({ text: formatWelcome(), thread_ts: threadTs });
    return;
  }

  // Claude execution via executor (clean formatted response)
  const projectId = getActiveProjectId(userId);
  const workingDir = await resolveWorkingDir(userId, projectId, getActiveWorkstream(userId));
  console.log(`[EXECUTOR] Running for user=${userId} projectId=${projectId} workstream=${getActiveWorkstream(userId)} workingDir=${workingDir} message="${message.slice(0, 80)}"`);
  const msgCount = sessionMessageCount.get(userId) ?? 0;

  const reactionEmoji = 'hourglass_flowing_sand';
  let reactionAdded = false;

  try {
    try {
      await client.reactions.add({ channel: channelId, timestamp: threadTs || messageTs, name: reactionEmoji });
      reactionAdded = true;
    } catch { /* not critical */ }

    const thinkingMsg = await say({ text: '🤔 _Thinking..._', thread_ts: threadTs });
    const updater = new StreamingMessageUpdater(client as unknown as import('@slack/web-api').WebClient, channelId, thinkingMsg.ts);

    const response = await executeClaudeCommand(
      message,
      { workingDir, continueSession: msgCount > 0 },
      (data) => { updater.appendChunk(data.chunk).catch(() => {}); },
    );

    sessionMessageCount.set(userId, msgCount + 1);
    await updater.finalize(response);
  } catch (error) {
    await say({ text: formatError(error as Error), thread_ts: threadTs });
  } finally {
    if (reactionAdded) {
      try { await client.reactions.remove({ channel: channelId, timestamp: threadTs || messageTs, name: reactionEmoji }); } catch { /* ok */ }
    }
  }
}

/**
 * Register all Slack event handlers
 */
export function registerEventHandlers(app: App): void {

  // @mentions → executor
  app.event('app_mention', async ({ event, say, client, context }: any) => {
    console.log(`[APP_MENTION] Received: user=${event.user} channel=${event.channel} text="${(event.text || '').slice(0, 80)}"`);
    try {
      await processMessage({
        userId: event.user, channelId: event.channel, inDM: false, text: event.text,
        botUserId: context.botUserId, say, client,
        threadTs: event.thread_ts || event.ts, messageTs: event.ts,
      });
    } catch (error) {
      console.error('[APP_MENTION] Error:', error);
    }
  });

  // DMs → executor
  app.event('message', async ({ event, say, client }: any) => {
    // A reply under a collaboration card is
    // stored and told to its sender, never answered by the DM executor.
    try {
      if (await handleCollabThreadMessage(event)) return;
    } catch (error) {
      console.error('[COLLAB] thread reply failed:', error);
      return;
    }
    // The message.channels subscription exists only for collaboration-card
    // threads. Channel messages must not reach the executor: a plain reply in
    // a channel thread would start an unattended Claude run. The executor
    // answers DMs (and @mentions, via app_mention) only, which is also why
    // there is no "follow this channel".
    if (event.channel_type !== 'im') return;
    if (event.subtype || event.bot_id) return;
    if (/<@[A-Z0-9]+>/.test(event.text || '')) return;

    try {
      await processMessage({
        userId: event.user, channelId: event.channel, inDM: true, text: event.text,
        botUserId: null, say, client,
        threadTs: event.thread_ts || event.ts, messageTs: event.ts,
      });
    } catch (error) {
      console.error('[DM] Error:', error);
    }
  });

  // /t — terminal commands routed to termag projects. What each form means is
  // slashCommand.ts; a command word counts only in the forms it takes.
  const slashT = async ({ command, client, respond }: any) => {
    const userId = command.user_id;
    // Seen only by the caller, and posted through the command's response_url,
    // so it reaches them even where the bot can't post.
    const reply = (text: string) => respond({ response_type: 'ephemeral', text });

    const refusal = await slackUserRefusal(userId, client);
    if (refusal) {
      await reply(slackRefusalText(refusal));
      return;
    }

    const termagUser = await resolveTermagUser(userId, client);
    const userCommand = command.text.trim();
    const access = slackProjectAccess(userId, termagUser?.id ?? null);
    const cmd = parseSlashCommand(userCommand);

    // ── /t help [command] ──────────────────────────────
    if (cmd.kind === 'help') {
      await reply(slashHelp(cmd.topic, { unscoped: access.unscoped }));
      return;
    }

    // ── /t local <subcommand> ──────────────────────────
    if (cmd.kind === 'local') {
      if (!access.unscoped) {
        await reply('Local sessions are only for the Slack IDs in `ALLOWED_SLACK_USERS`.');
        return;
      }
      const local = cmd.local;

      if (local.action === 'list') {
        const sessions = listLocalSessions();
        if (sessions.length === 0) {
          await client.chat.postMessage({ channel: command.channel_id, text: 'No local sessions. Use `/t local <name>` to register one.' });
        } else {
          const lines = sessions.map((s: any) => `• \`${s.name}\` ${s.hasContent ? '(connected)' : '(waiting)'}`).join('\n');
          await client.chat.postMessage({ channel: command.channel_id, text: `*Local Sessions*\n${lines}` });
        }
        return;
      }

      if (local.action === 'detach') {
        const name = local.name;
        if (!isLocalSession(name)) {
          await reply(`No local session \`${name}\`.`);
          return;
        }
        removeLocalSession(name);
        if (getActiveLocalSession(userId) === name) clearActiveLocalSession(userId);
        await client.chat.postMessage({ channel: command.channel_id, text: `Detached \`${name}\`.` });
        return;
      }

      const localName = local.name;
      if (!/^[a-zA-Z0-9._-]+$/.test(localName)) {
        await reply('Usage: `/t local <session-name>`');
        return;
      }
      if (isLocalSession(localName)) {
        await reply(`\`${localName}\` already registered.`);
        return;
      }

      const initMsg = await client.chat.postMessage({
        channel: command.channel_id,
        ...formatPaneForSlack('(waiting for daemon...)', null, `local:${localName}`, 'running'),
      });
      registerLocalSession(localName, { channel: command.channel_id, messageTs: initMsg.ts, userId });
      setActiveLocalSession(userId, localName);
      return;
    }

    // ── /t create <project-name> ─────────────────────────
    if (cmd.kind === 'create') {
      if (!termagUser) {
        await reply('Your Slack account is not linked to a termag user.');
        return;
      }
      const projectName = cmd.name;
      if (!/^[a-zA-Z0-9_-]+$/.test(projectName)) {
        await reply('Project name must be alphanumeric with dashes/underscores only.' + typeInstead(userCommand));
        return;
      }
      // Chat-created projects run on this host (there's no box picker here),
      // which is admin-only — same rule as POST /api/projects.
      if (!isAdminUser(termagUser)) {
        await reply('Projects must run on a box — create this one from the termag web UI.' + typeInstead(userCommand));
        return;
      }
      try {
        // Create project directory
        const projDir = projectDir(termagUser.unixUsername, projectName);
        if (isAgentConnected(termagUser.id)) {
          await sendToAgent(termagUser.id, 'mkdir', { dir: projDir });
          sendToAgent(termagUser.id, 'init-wiki', {
            dir: projDir, slug: projectName, username: termagUser.unixUsername,
          }).catch(() => {});
        }

        // Create project in DB
        const project = await prisma.project.create({
          data: { name: projectName, userId: termagUser.id },
        });

        const ws = await ensureMainWorkstream(project.id);

        // Add agent workflow + tmux sessions
        await prisma.workflow.create({
          data: { projectId: project.id, workstreamId: ws.id, type: 'agent', provider: termagUser.defaultAgentProvider },
        });

        if (isAgentConnected(termagUser.id)) {
          await ensureAgentSessionsAndLaunch({
            userId: termagUser.id,
            unixUsername: termagUser.unixUsername,
            projectName,
            provider: termagUser.defaultAgentProvider,
            // Slack/Discord-created projects always use the legacy per-user
            // agent — there's no chat affordance to pick a box.
            instanceId: null,
            workstream: ws.name,
          });
        } else {
          await client.chat.postMessage({ channel: command.channel_id, text: `Project \`${projectName}\` created but agent is not connected — tmux sessions not started.` });
          return;
        }

        // Create Slack channel (#proj-<user>-<project>)
        createProjectChannel(termagUser.unixUsername, projectName, userId).then(channelId => {
          if (channelId) {
            prisma.project.update({
              where: { id: project.id },
              data: { slackChannelId: channelId },
            }).catch(err => console.error('[SLACK] Failed to save channel ID:', err.message));
          }
        });

        setActiveProjectId(userId, project.id);
        const agentSession = sessionName(termagUser.unixUsername, projectName, 'agent');
        setNotificationTarget(agentSession, { channel: command.channel_id, userId }, 'slack', null);
        await client.chat.postMessage({ channel: command.channel_id, text: `Project \`${projectName}\` created with agent workflow. Switched to it.` });
      } catch (err: unknown) {
        if ((err as { code?: string }).code === 'P2002') {
          await reply(`Project \`${projectName}\` already exists.`);
        } else {
          console.error('[SLACK] /t create failed:', (err as Error).message);
          await reply(`Failed to create project: ${(err as Error).message}`);
        }
      }
      return;
    }

    // ── /t projects ────────────────────────────────────
    if (cmd.kind === 'projects') {
      // Owned and shared, the projects a flag user's /t may reach.
      const projects = await prisma.project.findMany({
        where: {
          archived: false,
          ...(termagUser ? { OR: [{ userId: termagUser.id }, { shares: { some: { userId: termagUser.id } } }] } : {}),
        },
        include: { workflows: true, user: true, workstreams: { where: { archived: false }, orderBy: { createdAt: 'asc' } } },
        orderBy: { name: 'asc' },
      });
      if (projects.length === 0) {
        await client.chat.postMessage({ channel: command.channel_id, text: 'No projects. Create one in the termag web UI.' });
        return;
      }
      const activeId = getActiveProjectId(userId);
      const activeWs = getActiveWorkstream(userId);
      const lines = projects.flatMap(p => {
        const isActiveProject = p.id === activeId;
        const active = isActiveProject && activeWs === 'main' ? ' ✅' : '';
        const hasAgent = p.workflows.some(w => w.type === 'agent') ? '🤖' : '  ';
        const extra = p.workstreams.filter(w => w.name !== 'main');
        const owner = p.userId === termagUser?.id ? '' : ` · ${p.user.unixUsername}'s`;
        return [
          `${hasAgent} \`${p.name}\`${owner}${active}`,
          ...extra.map(w => `      ↳ \`${p.name}/${w.name}\`${isActiveProject && activeWs === w.name ? ' ✅' : ''}`),
        ];
      }).join('\n');
      await client.chat.postMessage({ channel: command.channel_id, text: `*Projects*\n${lines}\n\nUse \`/t switch <project>[/<workstream>]\` to change.` });
      return;
    }

    // ── /t switch <project>[/<workstream>] ─────────────
    if (cmd.kind === 'switch') {
      const [projectName, wsName = 'main'] = cmd.target.split('/');
      const include = { user: true, workstreams: { where: { archived: false }, select: { name: true } } };
      const owned = termagUser
        ? await prisma.project.findMany({ where: { name: projectName, archived: false, userId: termagUser.id }, include })
        : [];
      const found = owned.length > 0
        ? owned
        : await prisma.project.findMany({ where: { name: projectName, archived: false }, include });
      // Someone else's project is "No project", as on the web.
      const named = [];
      for (const p of found) if (await access.mayReach(p.id)) named.push(p);
      if (named.length === 0) {
        await reply(`No project \`${projectName}\`. Use \`/t projects\` to list.` + typeInstead(userCommand));
        return;
      }
      if (named.length > 1) {
        await reply(`More than one project named \`${projectName}\`. Open the one you want from the project list.`);
        return;
      }
      const project = named[0];
      if (wsName !== 'main' && !project.workstreams.some(w => w.name === wsName)) {
        await reply(`No workstream \`${wsName}\` in \`${project.name}\`. Use \`/t projects\` to list.` + typeInstead(userCommand));
        return;
      }
      setActiveProjectId(userId, project.id, wsName);
      clearActiveLocalSession(userId);
      const agentSession = sessionName(project.user.unixUsername, project.name, 'agent', wsName);
      setNotificationTarget(agentSession, { channel: command.channel_id, userId }, 'slack', project.instanceId);
      const pane = await capturePaneForSlack(agentSession, 200, project.instanceId);
      const switchMsg = await client.chat.postMessage({
        channel: command.channel_id,
        ...formatPaneForSlack(pane, null, agentSession, 'idle'),
      });
      trackPaneMessage(command.channel_id, switchMsg.ts, agentSession, userId, project.instanceId);
      await addReactionHints(client, command.channel_id, switchMsg.ts, pane);
      return;
    }

    // ── /t ls ──────────────────────────────────────────
    if (cmd.kind === 'sessions') {
      const hosts = termagUser ? await sessionsByHost(termagUser.id) : [];
      if (hosts.length === 0) {
        await client.chat.postMessage({ channel: command.channel_id, text: 'No tmux sessions on your boxes.' });
      } else {
        const text = hosts.map(h => `*${h.label}*\n\`\`\`\n${h.sessions.join('\n')}\n\`\`\``).join('\n');
        await client.chat.postMessage({ channel: command.channel_id, text });
      }
      return;
    }

    // ── /t attach <session-name> ───────────────────────
    if (cmd.kind === 'attach') {
      const target = cmd.session;
      const resolved = await resolveSessionProject(target);
      if (isAmbiguousSession(resolved)) {
        await reply(`\`${target}\` matches more than one project.`);
        return;
      }
      const opScope = resolved ? operationScopeForResolvedSession(resolved) : undefined;
      if (!resolved || !(await access.mayReach(resolved.projectId)) || !await hasSession(target, opScope)) {
        await reply(`No tmux session \`${target}\`.` + typeInstead(userCommand));
        return;
      }
      if (resolved.projectId) setActiveProjectId(userId, resolved.projectId, resolved.workstream ?? 'main');
      clearActiveLocalSession(userId);

      setNotificationTarget(target, { channel: command.channel_id, userId }, 'slack', resolved.instanceId);
      const pane = await capturePaneForSlack(target, 200, opScope);
      const attachMsg = await client.chat.postMessage({
        channel: command.channel_id,
        ...formatPaneForSlack(pane, null, target, 'idle'),
      });
      trackPaneMessage(command.channel_id, attachMsg.ts, target, userId, opScope);
      await addReactionHints(client, command.channel_id, attachMsg.ts, pane);
      return;
    }

    // ── /t handoff [mode] [agent] ──────────────────────
    // A handoff: the agent writes a handoff, then its context is
    // reset (or the pane restarted) and the next agent starts on it.
    if (cmd.kind === 'handoff') {
      if (!termagUser) {
        await reply('Your Slack account is not linked to a termag user.');
        return;
      }
      const target = await slashTarget(command, userId, termagUser.id, access);
      if (target === 'refused') {
        await reply(NOT_YOURS);
        return;
      }
      if (!target) {
        await reply('No active project. Use `/t switch <project>[/<workstream>]` or run from a project channel.');
        return;
      }
      const text = await slackHandoff(termagUser, { projectId: target.project.id, projectName: target.project.name, workstream: target.workstream }, userCommand);
      await client.chat.postMessage({ channel: command.channel_id, text });
      return;
    }

    // ── /t ctrl <command> ──────────────────────────────
    if (cmd.kind === 'ctrl') {
      const ctrlCmd = cmd.text;
      // Resolve target: channel-based first (with #proj-… name fallback), then active target
      const target = await slashTarget(command, userId, termagUser?.id, access);
      if (target === 'refused') {
        await reply(NOT_YOURS);
        return;
      }
      if (!target) {
        await reply('No active project. Use `/t switch <project>[/<workstream>]` or run from a project channel.');
        return;
      }
      const { project, workstream } = target;

      const ctrlSession = sessionName(project.user.unixUsername, project.name, 'ctrl', workstream);
      const ctrlHost = project.instanceId;
      if (!await hasSession(ctrlSession, ctrlHost)) {
        await reply(`No ctrl session for \`${project.name}${workstream === 'main' ? '' : '/' + workstream}\`.`);
        return;
      }

      if (!ctrlCmd) {
        const pane = await capturePaneForSlack(ctrlSession, 200, ctrlHost);
        const ctrlPaneMsg = await client.chat.postMessage({ channel: command.channel_id, ...formatPaneForSlack(pane, null, ctrlSession, 'idle') });
        trackPaneMessage(command.channel_id, ctrlPaneMsg.ts, ctrlSession, userId, ctrlHost);
        await addReactionHints(client, command.channel_id, ctrlPaneMsg.ts, pane);
        return;
      }

      const pane = await capturePaneForSlack(ctrlSession, 200, ctrlHost);
      const ctrlCmdMsg = await client.chat.postMessage({
        channel: command.channel_id,
        ...formatPaneForSlack(pane, ctrlCmd, ctrlSession, 'running'),
      });
      trackPaneMessage(command.channel_id, ctrlCmdMsg.ts, ctrlSession, userId, ctrlHost);
      const noEnter = ctrlCmd.startsWith('!');
      await sendKeys(ctrlSession, noEnter ? ctrlCmd.slice(1) : ctrlCmd, !noEnter, ctrlHost);
      await pollUntilStable(client, command.channel_id, ctrlCmdMsg.ts, ctrlSession, ctrlCmd, 30, ctrlHost);
      const ctrlFinalPane = await capturePaneForSlack(ctrlSession, 200, ctrlHost);
      await addReactionHints(client, command.channel_id, ctrlCmdMsg.ts, ctrlFinalPane);
      return;
    }

    // ── Default: type into the target ──────────────────
    // `/t -- <text>` (literal) is typed exactly as written: a leading `!` is
    // kept and the first word is never a local session's name. It still goes
    // where any text goes, an active local session included: `--` changes how
    // the text is read, not where it is typed.
    const { text, literal } = cmd;

    // ── Check local sessions ───────────────────────────
    const firstWord = text.split(/\s+/)[0];
    if (!literal && access.unscoped && isLocalSession(firstWord)) {
      const localCmd = text.slice(firstWord.length).trim();
      if (!localCmd) {
        const msg = await client.chat.postMessage({
          channel: command.channel_id,
          ...formatPaneForSlack('(refreshing...)', null, `local:${firstWord}`, 'running'),
        });
        updateLocalSessionMessage(firstWord, msg.ts, command.channel_id);
        return;
      }
      const msg = await client.chat.postMessage({
        channel: command.channel_id,
        ...formatPaneForSlack('(executing...)', localCmd, `local:${firstWord}`, 'running'),
      });
      queueLocalCommand(firstWord, localCmd, { messageTs: msg.ts, channel: command.channel_id });
      return;
    }

    const activeLocal = access.unscoped ? getActiveLocalSession(userId) : null;
    if (activeLocal) {
      if (!text) {
        const msg = await client.chat.postMessage({
          channel: command.channel_id,
          ...formatPaneForSlack('(refreshing...)', null, `local:${activeLocal}`, 'running'),
        });
        updateLocalSessionMessage(activeLocal, msg.ts, command.channel_id);
        return;
      }
      const msg = await client.chat.postMessage({
        channel: command.channel_id,
        ...formatPaneForSlack('(executing...)', text, `local:${activeLocal}`, 'running'),
      });
      queueLocalCommand(activeLocal, text, { messageTs: msg.ts, channel: command.channel_id });
      return;
    }

    // ── Default: send to the target's agent session ─────
    // Resolve target: channel-based first (with #proj-… name fallback), then active target, then auto-select
    const target = await slashTarget(command, userId, termagUser?.id, access);
    if (target === 'refused') {
      await reply(NOT_YOURS);
      return;
    }
    let agentSession: string;
    let hostInstance: string | null = null;

    if (target) {
      agentSession = sessionName(target.project.user.unixUsername, target.project.name, 'agent', target.workstream);
      hostInstance = target.project.instanceId;
    } else if (getActiveProjectId(userId)) {
      // The active project is gone (archived or deleted): say so rather than
      // typing into a session that no longer exists.
      clearActiveTarget('slack', userId);
      await reply('The project you switched to is gone. Use `/t projects` and `/t switch <project>[/<workstream>]` to pick another.');
      return;
    } else {
      // The caller's own first, then one shared with them: what `/t projects` lists.
      const firstWhere = (where: Prisma.ProjectWhereInput) => prisma.project.findFirst({
        where: { archived: false, workflows: { some: { type: 'agent' } }, ...where }, include: { user: true }, orderBy: { name: 'asc' },
      });
      const first = termagUser
        ? await firstWhere({ userId: termagUser.id }) ?? await firstWhere({ shares: { some: { userId: termagUser.id } } })
        : await firstWhere({});
      if (first) {
        guessActiveProjectId(userId, first.id);
        agentSession = sessionName(first.user.unixUsername, first.name, 'agent');
        hostInstance = first.instanceId;
      } else {
        await reply('No projects with agent workflows. Create one in the termag UI.');
        return;
      }
    }

    setNotificationTarget(agentSession, { channel: command.channel_id, userId }, 'slack', hostInstance);

    if (!text) {
      const pane = await capturePaneForSlack(agentSession, 200, hostInstance);
      const paneMsg = await client.chat.postMessage({
        channel: command.channel_id,
        ...formatPaneForSlack(pane, null, agentSession, 'idle'),
      });
      trackPaneMessage(command.channel_id, paneMsg.ts, agentSession, userId, hostInstance);
      await addReactionHints(client, command.channel_id, paneMsg.ts, pane);
      return;
    }

    // /t <command> — send to agent
    const noEnter = !literal && text.startsWith('!');
    const keysToSend = noEnter ? text.slice(1) : text;

    const pane = await capturePaneForSlack(agentSession, 200, hostInstance);
    const msg = await client.chat.postMessage({
      channel: command.channel_id,
      ...formatPaneForSlack(pane, text, agentSession, 'running'),
    });
    trackPaneMessage(command.channel_id, msg.ts, agentSession, userId, hostInstance);

    await sendKeys(agentSession, keysToSend, !noEnter, hostInstance);
    await pollUntilStable(client, command.channel_id, msg.ts, agentSession, text, 30, hostInstance);

    const finalPane = await capturePaneForSlack(agentSession, 200, hostInstance);
    await addReactionHints(client, command.channel_id, msg.ts, finalPane);
  };

  app.command('/t', async (args: any) => {
    await args.ack();
    try {
      await slashT(args);
    } catch (error) {
      // Without this a failed post (a private channel or group DM the bot is
      // not in) left the caller with nothing at all.
      console.error('[SLACK] /t failed:', error);
      try { await args.respond({ response_type: 'ephemeral', text: slashFailureText(error) }); } catch { /* response_url expired */ }
    }
  });

  // App Home
  app.event('app_home_opened', async ({ event, client }: any) => {
    try {
      activeHomeViewers.add(event.user);
      await publishHomeView(client, event.user);
    } catch (error) {
      console.error('[HOME] Error:', error);
    }
  });

  // Home tab: Attach to a project
  app.action('home_attach_project', async ({ ack, body, action, client }: any) => {
    await ack();
    setActiveProjectId(body.user.id, action.value);
    await publishHomeView(client, body.user.id);
  });

  // Home tab: Attach to local session
  app.action('home_attach_local_session', async ({ ack, body, action, client }: any) => {
    await ack();
    if (isLocalSession(action.value)) {
      setActiveLocalSession(body.user.id, action.value);
      await publishHomeView(client, body.user.id);
    }
  });

  // ── Emoji reactions → terminal commands ────────────────────
  app.event('reaction_added', async ({ event, client }: any) => {
    try {
      const emoji = event.reaction;
      const mapping = EMOJI_KEYS[emoji];
      if (!mapping) return; // not a recognized emoji

      const key = `${event.item.channel}:${event.item.ts}`;
      const target = reactionTargets.get(key);
      if (!target) return; // not a tracked pane message
      if (target.expiresAt < Date.now()) {
        reactionTargets.delete(key);
        return;
      }

      // Only respond to the user who created the original /t command
      if (event.user !== target.userId) return;

      // Send keystroke (unless refresh-only)
      if (mapping.keys || mapping.withEnter) {
        await sendKeys(target.sessionName, mapping.keys, mapping.withEnter, target.instanceId);
      }

      const label = emoji === 'arrows_counterclockwise' ? null : `(${emoji})`;
      const pane = await capturePaneForSlack(target.sessionName, 200, target.instanceId);
      const msg = await client.chat.postMessage({
        channel: target.channelId,
        ...formatPaneForSlack(pane, label, target.sessionName, 'running'),
      });

      trackPaneMessage(target.channelId, msg.ts, target.sessionName, target.userId, target.instanceId);

      await pollUntilStable(client, target.channelId, msg.ts, target.sessionName, label, 30, target.instanceId);

      const finalPane = await capturePaneForSlack(target.sessionName, 200, target.instanceId);
      await addReactionHints(client, target.channelId, msg.ts, finalPane);
    } catch (error) {
      console.error('[REACTION] Error:', error);
    }
  });
}
