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
import {
  sessionName, workSessionName, ensureSession, hasSession,
  listSessions as tmuxListSessions, sendKeys,
  capturePaneForSlack, formatPaneForSlack, pollUntilStable,
} from '../services/tmux';
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
 * For now, returns 'secorp' — multi-user would need a Slack→unix mapping.
 */
async function resolveUnixUsername(_slackUserId: string): Promise<string> {
  // TODO: look up from users table by Slack ID
  return 'secorp';
}

function getActiveProjectId(userId: string): string | null {
  return activeProjectMap.get(userId) ?? null;
}

function setActiveProjectId(userId: string, projectId: string): void {
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

    const username = await resolveUnixUsername(userId);
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

    // ── /t projects ────────────────────────────────────
    if (userCommand === 'projects') {
      const projects = await prisma.project.findMany({
        where: { archived: false },
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
      const agentSession = sessionName(username, project.name, 'agent');
      setNotificationTarget(agentSession, { channel: command.channel_id, userId });
      const pane = await capturePaneForSlack(agentSession);
      await client.chat.postMessage({
        channel: command.channel_id,
        ...formatPaneForSlack(pane, null, agentSession, 'idle'),
      });
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

      setNotificationTarget(target, { channel: command.channel_id, userId });
      const pane = await capturePaneForSlack(target);
      await client.chat.postMessage({
        channel: command.channel_id,
        ...formatPaneForSlack(pane, null, target, 'idle'),
      });
      return;
    }

    // ── /t ctrl <command> ──────────────────────────────
    if (userCommand.startsWith('ctrl')) {
      const ctrlCmd = userCommand.slice(4).trim();
      const projectId = getActiveProjectId(userId);
      if (!projectId) {
        await client.chat.postMessage({ channel: command.channel_id, text: 'No active project. Use `/t switch <name>` first.' });
        return;
      }
      const project = await prisma.project.findUnique({ where: { id: projectId }, include: { user: true } });
      if (!project) { await client.chat.postMessage({ channel: command.channel_id, text: 'Project not found.' }); return; }

      const ctrlSession = sessionName(project.user.unixUsername, project.name, 'ctrl');
      if (!await hasSession(ctrlSession)) {
        await client.chat.postMessage({ channel: command.channel_id, text: `No ctrl session for \`${project.name}\`.` });
        return;
      }

      if (!ctrlCmd) {
        const pane = await capturePaneForSlack(ctrlSession);
        await client.chat.postMessage({ channel: command.channel_id, ...formatPaneForSlack(pane, null, ctrlSession, 'idle') });
        return;
      }

      const pane = await capturePaneForSlack(ctrlSession);
      const msg = await client.chat.postMessage({
        channel: command.channel_id,
        ...formatPaneForSlack(pane, ctrlCmd, ctrlSession, 'running'),
      });
      const noEnter = ctrlCmd.startsWith('!');
      await sendKeys(ctrlSession, noEnter ? ctrlCmd.slice(1) : ctrlCmd, !noEnter);
      await pollUntilStable(client, command.channel_id, msg.ts, ctrlSession, ctrlCmd, 30);
      return;
    }

    // ── /t work <name> <command> ───────────────────────
    if (userCommand.startsWith('work ')) {
      const rest = userCommand.slice(5).trim();
      const spaceIdx = rest.indexOf(' ');
      const termName = spaceIdx > 0 ? rest.substring(0, spaceIdx) : rest;
      const workCmd = spaceIdx > 0 ? rest.substring(spaceIdx + 1).trim() : '';

      const workSession = workSessionName(username, termName);
      if (!await hasSession(workSession)) {
        await client.chat.postMessage({ channel: command.channel_id, text: `No work terminal \`${termName}\`. Create one in the termag UI.` });
        return;
      }

      if (!workCmd) {
        const pane = await capturePaneForSlack(workSession);
        await client.chat.postMessage({ channel: command.channel_id, ...formatPaneForSlack(pane, null, workSession, 'idle') });
        return;
      }

      const pane = await capturePaneForSlack(workSession);
      const msg = await client.chat.postMessage({
        channel: command.channel_id,
        ...formatPaneForSlack(pane, workCmd, workSession, 'running'),
      });
      const noEnter = workCmd.startsWith('!');
      await sendKeys(workSession, noEnter ? workCmd.slice(1) : workCmd, !noEnter);
      await pollUntilStable(client, command.channel_id, msg.ts, workSession, workCmd, 30);
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
    const projectId = getActiveProjectId(userId);
    let agentSession: string;

    if (projectId) {
      const project = await prisma.project.findUnique({ where: { id: projectId }, include: { user: true } });
      if (project) {
        agentSession = sessionName(project.user.unixUsername, project.name, 'agent');
      } else {
        agentSession = `term-${userId}`;
      }
    } else {
      // No active project — try to auto-select the first one
      const first = await prisma.project.findFirst({
        where: { archived: false, workflows: { some: { type: 'agent' } } },
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

    setNotificationTarget(agentSession, { channel: command.channel_id, userId });

    // /t (no args) — pane screenshot
    if (!userCommand) {
      const pane = await capturePaneForSlack(agentSession);
      await client.chat.postMessage({
        channel: command.channel_id,
        ...formatPaneForSlack(pane, null, agentSession, 'idle'),
      });
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

    await sendKeys(agentSession, keysToSend, !noEnter);
    await pollUntilStable(client, command.channel_id, msg.ts, agentSession, userCommand, 30);
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
}
