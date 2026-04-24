/**
 * Slack Event Handlers
 *
 * Handles @mentions, DMs, and /t commands.
 * DMs/mentions → executor (spawns claude with stream-json)
 * /t commands → tmux (send-keys + capture-pane)
 */

// App type used loosely — Bolt's CJS export doesn't play well with TS imports
type App = any;
import { PrismaClient } from '@prisma/client';
import { exec } from 'child_process';
import { promisify } from 'util';
import { writeFile } from 'fs/promises';
import { join } from 'path';

import { executeClaudeCommand, resolveWorkingDir } from './executor';
import { StreamingMessageUpdater } from './streaming';
import { formatResponse, formatError, formatWelcome, splitMessage } from './formatting';
import { publishHomeView } from './homeView';
import { resolveTermagUser } from './userMapping';
import {
  sessionName, projectDir, ensureSession, hasSession,
  listSessions as tmuxListSessions, sendKeys,
  capturePaneForSlack, formatPaneForSlack, pollUntilStable,
} from '../services/tmux';
import { isAgentConnected, sendToAgent } from '../services/agentRegistry';
import { ensureAgentSessionsAndLaunch } from '../services/agentRuntime';
import {
  registerLocalSession, queueLocalCommand, isLocalSession,
  removeLocalSession, listLocalSessions, updateLocalSessionMessage,
  setActiveLocalSession, getActiveLocalSession, clearActiveLocalSession,
  setNotificationTarget,
} from './lts';

const prisma = new PrismaClient();
const execAsync = promisify(exec);

// Track users who have the App Home tab open
const activeHomeViewers = new Set<string>();
export function getActiveHomeViewers() { return activeHomeViewers; }

// In-memory: userId → active termag project ID
const activeProjectMap = new Map<string, string>();
// In-memory: userId → session message count (for --continue)
const sessionMessageCount = new Map<string, number>();
// In-memory: channel following
const followedThreads = new Set<string>(); // "channel:ts"
const followedChannels = new Set<string>();

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
  expiresAt: number;
}
const reactionTargets = new Map<string, ReactionTarget>();
const REACTION_TTL = 60 * 60 * 1000; // 1 hour

export function trackPaneMessage(channelId: string, messageTs: string, tmuxSession: string, userId: string): void {
  // Prune expired entries lazily
  const now = Date.now();
  for (const [key, val] of reactionTargets) {
    if (val.expiresAt < now) reactionTargets.delete(key);
  }
  reactionTargets.set(`${channelId}:${messageTs}`, {
    sessionName: tmuxSession,
    userId,
    channelId,
    expiresAt: now + REACTION_TTL,
  });
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

const ALLOWED_USERS = process.env.ALLOWED_SLACK_USERS
  ? new Set(process.env.ALLOWED_SLACK_USERS.split(',').map(id => id.trim()).filter(Boolean))
  : null;

function isRateLimited(userId: string): boolean {
  const now = Date.now();
  if (now - (userLastRequest.get(userId) ?? 0) < RATE_LIMIT_MS) return true;
  userLastRequest.set(userId, now);
  return false;
}

/**
 * Resolve the unix username for a Slack user.
 * Looks up the termag user via Slack ID → email → googleEmail match.
 */
async function resolveUnixUsername(slackUserId: string, slackClient?: any): Promise<string> {
  const user = await resolveTermagUser(slackUserId, slackClient);
  return user?.unixUsername ?? 'secorp';
}

export function getActiveProjectId(userId: string): string | null {
  return activeProjectMap.get(userId) ?? null;
}

export function setActiveProjectId(userId: string, projectId: string): void {
  activeProjectMap.set(userId, projectId);
}

/**
 * Process a DM or @mention — route to executor (clean Claude response)
 */
async function processMessage(opts: {
  userId: string;
  channelId: string;
  text: string;
  botUserId?: string | null;
  say: (args: Record<string, unknown>) => Promise<{ ts: string }>;
  client: { chat: { update: (a: Record<string, unknown>) => Promise<unknown>; postMessage: (a: Record<string, unknown>) => Promise<{ ts: string }> }; reactions: { add: (a: Record<string, unknown>) => Promise<unknown>; remove: (a: Record<string, unknown>) => Promise<unknown> } };
  threadTs: string;
  messageTs: string;
}): Promise<void> {
  const { userId, channelId, text, botUserId, say, client, threadTs, messageTs } = opts;

  if (ALLOWED_USERS && !ALLOWED_USERS.has(userId)) return;
  if (isRateLimited(userId)) {
    await say({ text: '⏳ Please wait a moment.', thread_ts: threadTs });
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
  if (lower === 'follow this channel' || lower === 'follow channel') {
    followedChannels.add(channelId);
    await say({ text: '✅ *Now following this channel*\nI\'ll respond without @-mentions. Type `unfollow` to stop.', thread_ts: threadTs });
    return;
  }
  if (lower === 'unfollow' || lower === 'stop following') {
    if (threadTs && threadTs !== messageTs) {
      followedThreads.delete(`${channelId}:${threadTs}`);
      await say({ text: '✅ *Unfollowed this thread*', thread_ts: threadTs });
    } else {
      followedChannels.delete(channelId);
      await say({ text: '✅ *Unfollowed this channel*', thread_ts: threadTs });
    }
    return;
  }

  // Claude execution via executor (clean formatted response)
  const projectId = getActiveProjectId(userId);
  const workingDir = await resolveWorkingDir(userId, projectId);
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
    try {
      await processMessage({
        userId: event.user, channelId: event.channel, text: event.text,
        botUserId: context.botUserId, say, client,
        threadTs: event.thread_ts || event.ts, messageTs: event.ts,
      });
      followedThreads.add(`${event.channel}:${event.thread_ts || event.ts}`);
    } catch (error) {
      console.error('[APP_MENTION] Error:', error);
    }
  });

  // DMs + followed threads/channels → executor
  app.event('message', async ({ event, say, client }: any) => {
    const isDM = event.channel_type === 'im';
    const isFollowedThread = event.thread_ts && event.thread_ts !== event.ts &&
      followedThreads.has(`${event.channel}:${event.thread_ts}`);
    const isFollowedChannel = !event.thread_ts && followedChannels.has(event.channel);

    if (!isDM && !isFollowedThread && !isFollowedChannel) return;
    if (event.subtype || event.bot_id) return;
    if (/<@[A-Z0-9]+>/.test(event.text || '')) return;

    try {
      await processMessage({
        userId: event.user, channelId: event.channel, text: event.text,
        botUserId: null, say, client,
        threadTs: event.thread_ts || event.ts, messageTs: event.ts,
      });
    } catch (error) {
      console.error('[DM] Error:', error);
    }
  });

  // /t — terminal commands routed to termag projects
  app.command('/t', async ({ command, ack, client }: any) => {
    await ack();

    const userId = command.user_id;
    if (ALLOWED_USERS && !ALLOWED_USERS.has(userId)) return;

    const termagUser = await resolveTermagUser(userId, client);
    const username = termagUser?.unixUsername ?? 'secorp';
    const userCommand = command.text.trim();

    // ── /t local <subcommand> ──────────────────────────
    if (userCommand.startsWith('local')) {
      const localArgs = userCommand.slice(5).trim();

      if (localArgs === 'ls' || localArgs === 'list' || localArgs === '') {
        const sessions = listLocalSessions();
        if (sessions.length === 0) {
          await client.chat.postMessage({ channel: command.channel_id, text: 'No local sessions. Use `/t local <name>` to register one.' });
        } else {
          const lines = sessions.map((s: any) => `• \`${s.name}\` ${s.hasContent ? '(connected)' : '(waiting)'}`).join('\n');
          await client.chat.postMessage({ channel: command.channel_id, text: `*Local Sessions*\n${lines}` });
        }
        return;
      }

      if (localArgs.startsWith('detach ')) {
        const name = localArgs.slice(7).trim();
        if (!isLocalSession(name)) {
          await client.chat.postMessage({ channel: command.channel_id, text: `No local session \`${name}\`.` });
          return;
        }
        removeLocalSession(name);
        if (getActiveLocalSession(userId) === name) clearActiveLocalSession(userId);
        await client.chat.postMessage({ channel: command.channel_id, text: `Detached \`${name}\`.` });
        return;
      }

      const localName = localArgs;
      if (!localName || !/^[a-zA-Z0-9._-]+$/.test(localName)) {
        await client.chat.postMessage({ channel: command.channel_id, text: 'Usage: `/t local <session-name>`' });
        return;
      }
      if (isLocalSession(localName)) {
        await client.chat.postMessage({ channel: command.channel_id, text: `\`${localName}\` already registered.` });
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
    if (userCommand.startsWith('create ')) {
      if (!termagUser) {
        await client.chat.postMessage({ channel: command.channel_id, text: 'Your Slack account is not linked to a termag user.' });
        return;
      }
      const projectName = userCommand.slice(7).trim();
      if (!/^[a-zA-Z0-9_-]+$/.test(projectName)) {
        await client.chat.postMessage({ channel: command.channel_id, text: 'Project name must be alphanumeric with dashes/underscores only.' });
        return;
      }
      try {
        // Create project directory
        const projDir = projectDir(termagUser.unixUsername, projectName);
        if (isAgentConnected(termagUser.id)) {
          await sendToAgent(termagUser.id, 'mkdir', { dir: projDir });
        }

        // Create project in DB
        const project = await prisma.project.create({
          data: { name: projectName, userId: termagUser.id },
        });

        // Add agent workflow + tmux sessions
        await prisma.workflow.create({
          data: { projectId: project.id, type: 'agent', provider: termagUser.defaultAgentProvider },
        });

        if (isAgentConnected(termagUser.id)) {
          await ensureAgentSessionsAndLaunch({
            userId: termagUser.id,
            unixUsername: termagUser.unixUsername,
            projectName,
            provider: termagUser.defaultAgentProvider,
          });
        } else {
          await client.chat.postMessage({ channel: command.channel_id, text: `Project \`${projectName}\` created but agent is not connected — tmux sessions not started.` });
          return;
        }

        // Create Slack channel
        const { createProjectChannel } = await import('./channels');
        createProjectChannel(projectName, userId).then(channelId => {
          if (channelId) {
            prisma.project.update({
              where: { id: project.id },
              data: { slackChannelId: channelId },
            }).catch(err => console.error('[SLACK] Failed to save channel ID:', err.message));
          }
        });

        setActiveProjectId(userId, project.id);
        const agentSession = sessionName(termagUser.unixUsername, projectName, 'agent');
        setNotificationTarget(agentSession, { channel: command.channel_id, userId });
        await client.chat.postMessage({ channel: command.channel_id, text: `Project \`${projectName}\` created with agent workflow. Switched to it.` });
      } catch (err: unknown) {
        if ((err as { code?: string }).code === 'P2002') {
          await client.chat.postMessage({ channel: command.channel_id, text: `Project \`${projectName}\` already exists.` });
        } else {
          console.error('[SLACK] /t create failed:', (err as Error).message);
          await client.chat.postMessage({ channel: command.channel_id, text: `Failed to create project: ${(err as Error).message}` });
        }
      }
      return;
    }

    // ── /t projects ────────────────────────────────────
    if (userCommand === 'projects') {
      const projects = await prisma.project.findMany({
        where: { archived: false, ...(termagUser ? { userId: termagUser.id } : {}) },
        include: { workflows: true, user: true },
        orderBy: { name: 'asc' },
      });
      if (projects.length === 0) {
        await client.chat.postMessage({ channel: command.channel_id, text: 'No projects. Create one in the termag web UI.' });
        return;
      }
      const activeId = getActiveProjectId(userId);
      const lines = projects.map(p => {
        const active = p.id === activeId ? ' ✅' : '';
        const hasAgent = p.workflows.some(w => w.type === 'agent') ? '🤖' : '  ';
        return `${hasAgent} \`${p.name}\`${active}`;
      }).join('\n');
      await client.chat.postMessage({ channel: command.channel_id, text: `*Projects*\n${lines}\n\nUse \`/t switch <name>\` to change.` });
      return;
    }

    // ── /t switch <project-name> ───────────────────────
    if (userCommand.startsWith('switch ')) {
      const projectName = userCommand.slice(7).trim();
      const project = await prisma.project.findFirst({
        where: { name: projectName, archived: false },
        include: { workflows: true },
      });
      if (!project) {
        await client.chat.postMessage({ channel: command.channel_id, text: `No project \`${projectName}\`. Use \`/t projects\` to list.` });
        return;
      }
      setActiveProjectId(userId, project.id);
      clearActiveLocalSession(userId);
      const agentSession = sessionName(username, project.name, 'agent');
      setNotificationTarget(agentSession, { channel: command.channel_id, userId });
      const pane = await capturePaneForSlack(agentSession);
      const switchMsg = await client.chat.postMessage({
        channel: command.channel_id,
        ...formatPaneForSlack(pane, null, agentSession, 'idle'),
      });
      trackPaneMessage(command.channel_id, switchMsg.ts, agentSession, userId);
      await addReactionHints(client, command.channel_id, switchMsg.ts, pane);
      return;
    }

    // ── /t ls ──────────────────────────────────────────
    if (userCommand === 'ls' || userCommand === 'sessions') {
      const sessions = await tmuxListSessions();
      if (sessions.length === 0) {
        await client.chat.postMessage({ channel: command.channel_id, text: 'No tmux sessions.' });
      } else {
        await client.chat.postMessage({ channel: command.channel_id, text: '```\n' + sessions.join('\n') + '\n```' });
      }
      return;
    }

    // ── /t attach <session-name> ───────────────────────
    if (userCommand.startsWith('attach ')) {
      const target = userCommand.slice(7).trim();
      if (!await hasSession(target)) {
        await client.chat.postMessage({ channel: command.channel_id, text: `No tmux session \`${target}\`.` });
        return;
      }
      // Try to find matching termag project
      const projects = await prisma.project.findMany({ where: { archived: false }, include: { user: true } });
      const match = projects.find(p => sessionName(p.user.unixUsername, p.name, 'agent') === target);
      if (match) setActiveProjectId(userId, match.id);
      clearActiveLocalSession(userId);

      setNotificationTarget(target, { channel: command.channel_id, userId });
      const pane = await capturePaneForSlack(target);
      const attachMsg = await client.chat.postMessage({
        channel: command.channel_id,
        ...formatPaneForSlack(pane, null, target, 'idle'),
      });
      trackPaneMessage(command.channel_id, attachMsg.ts, target, userId);
      await addReactionHints(client, command.channel_id, attachMsg.ts, pane);
      return;
    }

    // ── /t ctrl <command> ──────────────────────────────
    if (userCommand.startsWith('ctrl')) {
      const ctrlCmd = userCommand.slice(4).trim();
      // Resolve project: channel-based first, then active project
      const channelProject = await prisma.project.findFirst({
        where: { slackChannelId: command.channel_id, archived: false },
        include: { user: true },
      });
      const projectId = channelProject?.id ?? getActiveProjectId(userId);
      if (!projectId) {
        await client.chat.postMessage({ channel: command.channel_id, text: 'No active project. Use `/t switch <name>` or run from a project channel.' });
        return;
      }
      const project = channelProject ?? await prisma.project.findUnique({ where: { id: projectId }, include: { user: true } });
      if (!project) { await client.chat.postMessage({ channel: command.channel_id, text: 'Project not found.' }); return; }

      const ctrlSession = sessionName(project.user.unixUsername, project.name, 'ctrl');
      if (!await hasSession(ctrlSession)) {
        await client.chat.postMessage({ channel: command.channel_id, text: `No ctrl session for \`${project.name}\`.` });
        return;
      }

      if (!ctrlCmd) {
        const pane = await capturePaneForSlack(ctrlSession);
        const ctrlPaneMsg = await client.chat.postMessage({ channel: command.channel_id, ...formatPaneForSlack(pane, null, ctrlSession, 'idle') });
        trackPaneMessage(command.channel_id, ctrlPaneMsg.ts, ctrlSession, userId);
        await addReactionHints(client, command.channel_id, ctrlPaneMsg.ts, pane);
        return;
      }

      const pane = await capturePaneForSlack(ctrlSession);
      const ctrlCmdMsg = await client.chat.postMessage({
        channel: command.channel_id,
        ...formatPaneForSlack(pane, ctrlCmd, ctrlSession, 'running'),
      });
      trackPaneMessage(command.channel_id, ctrlCmdMsg.ts, ctrlSession, userId);
      const noEnter = ctrlCmd.startsWith('!');
      await sendKeys(ctrlSession, noEnter ? ctrlCmd.slice(1) : ctrlCmd, !noEnter);
      await pollUntilStable(client, command.channel_id, ctrlCmdMsg.ts, ctrlSession, ctrlCmd, 30);
      // Re-check for hints after poll settles
      const ctrlFinalPane = await capturePaneForSlack(ctrlSession);
      await addReactionHints(client, command.channel_id, ctrlCmdMsg.ts, ctrlFinalPane);
      return;
    }

    // ── Check local sessions ───────────────────────────
    const firstWord = userCommand.split(/\s+/)[0];
    if (isLocalSession(firstWord)) {
      const localCmd = userCommand.slice(firstWord.length).trim();
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

    const activeLocal = getActiveLocalSession(userId);
    if (activeLocal) {
      if (!userCommand) {
        const msg = await client.chat.postMessage({
          channel: command.channel_id,
          ...formatPaneForSlack('(refreshing...)', null, `local:${activeLocal}`, 'running'),
        });
        updateLocalSessionMessage(activeLocal, msg.ts, command.channel_id);
        return;
      }
      const msg = await client.chat.postMessage({
        channel: command.channel_id,
        ...formatPaneForSlack('(executing...)', userCommand, `local:${activeLocal}`, 'running'),
      });
      queueLocalCommand(activeLocal, userCommand, { messageTs: msg.ts, channel: command.channel_id });
      return;
    }

    // ── Default: send to active project's agent session ─
    // Resolve project: channel-based first, then active project, then auto-select
    const channelProject = await prisma.project.findFirst({
      where: { slackChannelId: command.channel_id, archived: false },
      include: { user: true },
    });
    let agentSession: string;

    if (channelProject) {
      agentSession = sessionName(channelProject.user.unixUsername, channelProject.name, 'agent');
    } else {
      const projectId = getActiveProjectId(userId);
      if (projectId) {
        const project = await prisma.project.findUnique({ where: { id: projectId }, include: { user: true } });
        if (project) {
          agentSession = sessionName(project.user.unixUsername, project.name, 'agent');
        } else {
          agentSession = `term-${userId}`;
        }
      } else {
        // No active project — try to auto-select the first one (user's own projects only)
        const first = await prisma.project.findFirst({
          where: { archived: false, workflows: { some: { type: 'agent' } }, ...(termagUser ? { userId: termagUser.id } : {}) },
          include: { user: true },
          orderBy: { name: 'asc' },
        });
        if (first) {
          setActiveProjectId(userId, first.id);
          agentSession = sessionName(first.user.unixUsername, first.name, 'agent');
        } else {
          await client.chat.postMessage({ channel: command.channel_id, text: 'No projects with agent workflows. Create one in the termag UI.' });
          return;
        }
      }
    }

    setNotificationTarget(agentSession, { channel: command.channel_id, userId });

    // /t (no args) — pane screenshot
    if (!userCommand) {
      const pane = await capturePaneForSlack(agentSession);
      const paneMsg = await client.chat.postMessage({
        channel: command.channel_id,
        ...formatPaneForSlack(pane, null, agentSession, 'idle'),
      });
      trackPaneMessage(command.channel_id, paneMsg.ts, agentSession, userId);
      await addReactionHints(client, command.channel_id, paneMsg.ts, pane);
      return;
    }

    // /t <command> — send to agent
    const noEnter = userCommand.startsWith('!');
    const keysToSend = noEnter ? userCommand.slice(1) : userCommand;

    const pane = await capturePaneForSlack(agentSession);
    const msg = await client.chat.postMessage({
      channel: command.channel_id,
      ...formatPaneForSlack(pane, userCommand, agentSession, 'running'),
    });
    trackPaneMessage(command.channel_id, msg.ts, agentSession, userId);

    await sendKeys(agentSession, keysToSend, !noEnter);
    await pollUntilStable(client, command.channel_id, msg.ts, agentSession, userCommand, 30);

    // Add reaction hints after polling completes (final pane state)
    const finalPane = await capturePaneForSlack(agentSession);
    await addReactionHints(client, command.channel_id, msg.ts, finalPane);
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
        await sendKeys(target.sessionName, mapping.keys, mapping.withEnter);
      }

      // Post initial pane, then poll until stable (picks up follow-up prompts)
      const label = emoji === 'arrows_counterclockwise' ? null : `(${emoji})`;
      const pane = await capturePaneForSlack(target.sessionName);
      const msg = await client.chat.postMessage({
        channel: target.channelId,
        ...formatPaneForSlack(pane, label, target.sessionName, 'running'),
      });

      // Track immediately so chained reactions work even during polling
      trackPaneMessage(target.channelId, msg.ts, target.sessionName, target.userId);

      await pollUntilStable(client, target.channelId, msg.ts, target.sessionName, label, 30);

      // Add reaction hints on the final stable pane
      const finalPane = await capturePaneForSlack(target.sessionName);
      await addReactionHints(client, target.channelId, msg.ts, finalPane);
    } catch (error) {
      console.error('[REACTION] Error:', error);
    }
  });
}
