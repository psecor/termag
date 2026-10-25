/**
 * Discord Event Handlers
 *
 * Handles /t slash command and emoji reactions for terminal control.
 */

import { Client, ChatInputCommandInteraction, Message } from 'discord.js';
import { prisma } from '../db';
import { resolveDiscordUser } from './userMapping';
import { formatPaneForDiscord } from './formatting';
import { sessionName, projectDir, listSessions as tmuxListSessions } from '../services/tmux';
import { hasSession, sendKeys, capturePaneForSlack } from '../slack/tmuxAgent';
import { isAmbiguousSession, operationScopeForResolvedSession, resolveSessionProject } from '../services/sessionResolver';
import { setNotificationTarget } from '../slack/lts';
import { getActiveProjectId, guessActiveProjectId, setActiveProjectId } from '../slack/events';
import { isAgentConnected, sendToAgent } from '../services/agentRegistry';
import { ensureAgentSessionsAndLaunch } from '../services/agentRuntime';
import { ensureMainWorkstream } from '../services/workstreams';
import { isAdminUser } from '../services/admin/adminAccess';
import { projectSessionAccess, SessionAccessError } from '../services/sessionAccess';


// Emoji → keystroke mapping (matches Slack)
const EMOJI_KEYS: Record<string, { keys: string; withEnter: boolean }> = {
  '1️⃣': { keys: '1', withEnter: false },
  '2️⃣': { keys: '2', withEnter: false },
  '3️⃣': { keys: '3', withEnter: false },
  '4️⃣': { keys: '4', withEnter: false },
  '5️⃣': { keys: '5', withEnter: false },
  '✅': { keys: 'y', withEnter: true },
  '❌': { keys: 'n', withEnter: true },
  '↩️': { keys: '', withEnter: true },
  '🔄': { keys: '', withEnter: false }, // refresh only
};

const NUMBER_EMOJIS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣'];

// Track pane messages for reaction routing
interface ReactionTarget {
  sessionName: string;
  userId: string;
  channelId: string;
  instanceId?: string | null;
  expiresAt: number;
}
const reactionTargets = new Map<string, ReactionTarget>();
const REACTION_TTL = 60 * 60 * 1000;

export function trackDiscordPaneMessage(
  channelId: string,
  messageId: string,
  tmuxSession: string,
  userId: string,
  instanceId?: string | null,
): void {
  const now = Date.now();
  for (const [key, val] of reactionTargets) {
    if (val.expiresAt < now) reactionTargets.delete(key);
  }
  reactionTargets.set(`${channelId}:${messageId}`, {
    sessionName: tmuxSession,
    userId,
    channelId,
    instanceId,
    expiresAt: now + REACTION_TTL,
  });
}

export function trackedDiscordPaneInstance(channelId: string, messageId: string): string | null | undefined {
  return reactionTargets.get(`${channelId}:${messageId}`)?.instanceId;
}

function detectNumberedPrompts(paneContent: string): number {
  const lines = paneContent.split('\n').slice(-15);
  let maxNum = 0;
  for (const line of lines) {
    const match = line.match(/^\s*(\d+)[.)]\s/);
    if (match) {
      const n = parseInt(match[1], 10);
      if (n > 0 && n <= 5) maxNum = Math.max(maxNum, n);
    }
  }
  return maxNum;
}

export async function addDiscordReactionHints(message: Message, paneContent: string): Promise<void> {
  const count = detectNumberedPrompts(paneContent);
  if (count === 0) return;
  for (let i = 0; i < count; i++) {
    try {
      await message.react(NUMBER_EMOJIS[i]);
    } catch { /* ignore */ }
  }
}

// Poll for stable output and edit the Discord message
async function pollUntilStable(
  message: Message,
  tmuxSession: string,
  command: string | null,
  maxPolls: number,
  instanceId?: string | null,
): Promise<void> {
  let lastContent = '';
  let stableCount = 0;

  for (let i = 0; i < maxPolls; i++) {
    await new Promise(r => setTimeout(r, 1500));
    const pane = await capturePaneForSlack(tmuxSession, 200, instanceId);

    if (pane === lastContent) {
      stableCount++;
      if (stableCount >= 2) break;
    } else {
      stableCount = 0;
      lastContent = pane;
      try {
        await message.edit(formatPaneForDiscord(pane, command, tmuxSession));
      } catch { /* message may have been deleted */ }
    }
  }
}

export function registerDiscordEvents(client: Client): void {
  // Slash command handler
  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand() || interaction.commandName !== 't') return;

    const discordUserId = interaction.user.id;
    const termagUser = await resolveDiscordUser(discordUserId);

    if (!termagUser) {
      await interaction.reply({ content: 'Your Discord account is not linked to a termag user. Set `DISCORD_USER_MAP` or link in the database.', ephemeral: true });
      return;
    }

    const username = termagUser.unixUsername;
    const userCommand = (interaction.options.getString('command') ?? '').trim();

    // /t types into a project's panes, the owner's authority on the owner's
    // box: only for projects the linked termag user owns or was shared, the
    // web's check and Slack's (slack/access.ts). A session name, or a target
    // saved across restarts (slack/activeTargets.ts), is not a grant.
    const mayReach = async (projectId: string | null | undefined): Promise<boolean> => {
      if (!projectId) return false;
      try {
        await projectSessionAccess(termagUser.id, projectId);
        return true;
      } catch (err) {
        if (err instanceof SessionAccessError) return false;
        throw err;
      }
    };
    // Why a saved target was refused: an archived project of their own says so.
    const unreachable = (project: { userId: string; archived: boolean }) => (project.userId === termagUser.id && project.archived
      ? 'That project is archived. Use `/t switch <name>` to pick another.'
      : 'That project is not yours or shared with you.');

    // /t create <project-name>
    if (userCommand.startsWith('create ')) {
      const projectName = userCommand.slice(7).trim();
      if (!/^[a-zA-Z0-9_-]+$/.test(projectName)) {
        await interaction.reply('Project name must be alphanumeric with dashes/underscores only.');
        return;
      }
      // Chat-created projects run on this host (there's no box picker here),
      // which is admin-only — same rule as POST /api/projects.
      if (!isAdminUser(termagUser)) {
        await interaction.reply('Projects must run on a box — create this one from the termag web UI.');
        return;
      }
      try {
        const projDir = projectDir(username, projectName);
        if (isAgentConnected(termagUser.id)) {
          await sendToAgent(termagUser.id, 'mkdir', { dir: projDir });
          sendToAgent(termagUser.id, 'init-wiki', {
            dir: projDir, slug: projectName, username,
          }).catch(() => {});
        }

        const project = await prisma.project.create({
          data: { name: projectName, userId: termagUser.id },
        });

        const ws = await ensureMainWorkstream(project.id);

        await prisma.workflow.create({
          data: { projectId: project.id, workstreamId: ws.id, type: 'agent', provider: termagUser.defaultAgentProvider },
        });
        const agentSession = sessionName(username, projectName, 'agent');

        if (isAgentConnected(termagUser.id)) {
          await ensureAgentSessionsAndLaunch({
            userId: termagUser.id,
            unixUsername: username,
            projectName,
            provider: termagUser.defaultAgentProvider,
            // Slack/Discord-created projects always use the legacy per-user
            // agent — there's no UI affordance to pick a box.
            instanceId: null,
            workstream: ws.name,
          });
        } else {
          await interaction.reply(`Project \`${projectName}\` created but agent is not connected — tmux sessions not started.`);
          return;
        }

        // Create Slack channel (if Slack is configured)
        const { createProjectChannel } = await import('../slack/channels');
        createProjectChannel(termagUser.unixUsername, projectName, termagUser.slackUserId ?? undefined).then(channelId => {
          if (channelId) {
            prisma.project.update({
              where: { id: project.id },
              data: { slackChannelId: channelId },
            }).catch(err => console.error('[DISCORD] Failed to save channel ID:', err.message));
          }
        });

        setActiveProjectId(discordUserId, project.id, 'main', 'discord');
        setNotificationTarget(agentSession, { channel: interaction.channelId, userId: discordUserId }, 'discord', null);
        await interaction.reply(`Project \`${projectName}\` created with agent workflow. Switched to it.`);
      } catch (err: unknown) {
        if ((err as { code?: string }).code === 'P2002') {
          await interaction.reply(`Project \`${projectName}\` already exists.`);
        } else {
          console.error('[DISCORD] /t create failed:', (err as Error).message);
          await interaction.reply(`Failed to create project: ${(err as Error).message}`);
        }
      }
      return;
    }

    // /t projects
    if (userCommand === 'projects') {
      const projects = await prisma.project.findMany({
        where: { userId: termagUser.id, archived: false },
        include: { workflows: true },
        orderBy: { name: 'asc' },
      });
      if (projects.length === 0) {
        await interaction.reply('No projects. Create one in the termag web UI.');
        return;
      }
      const activeId = getActiveProjectId(discordUserId);
      const lines = projects.map(p => {
        const active = p.id === activeId ? ' ✅' : '';
        const hasAgent = p.workflows.some(w => w.type === 'agent') ? '🤖' : '  ';
        return `${hasAgent} \`${p.name}\`${active}`;
      }).join('\n');
      await interaction.reply(`**Projects**\n${lines}\n\nUse \`/t switch <name>\` to change.`);
      return;
    }

    // /t switch <project>
    if (userCommand.startsWith('switch ')) {
      const projectName = userCommand.slice(7).trim();
      const named = await prisma.project.findMany({
        where: { name: projectName, userId: termagUser.id, archived: false },
        include: { workflows: true },
      });
      if (named.length === 0) {
        await interaction.reply(`No project \`${projectName}\`. Use \`/t projects\` to list.`);
        return;
      }
      if (named.length > 1) {
        await interaction.reply(`More than one project named \`${projectName}\`. Open the one you want from the project list.`);
        return;
      }
      const project = named[0];
      setActiveProjectId(discordUserId, project.id, 'main', 'discord');
      const agentSession = sessionName(username, project.name, 'agent');
      setNotificationTarget(agentSession, { channel: interaction.channelId, userId: discordUserId }, 'discord', project.instanceId);
      const pane = await capturePaneForSlack(agentSession, 200, project.instanceId);
      const msg = await interaction.reply({ ...formatPaneForDiscord(pane, null, agentSession), fetchReply: true });
      trackDiscordPaneMessage(interaction.channelId, msg.id, agentSession, discordUserId, project.instanceId);
      await addDiscordReactionHints(msg, pane);
      return;
    }

    // /t ls
    if (userCommand === 'ls' || userCommand === 'sessions') {
      const sessions = await tmuxListSessions();
      if (sessions.length === 0) {
        await interaction.reply('No tmux sessions.');
      } else {
        await interaction.reply('```\n' + sessions.join('\n') + '\n```');
      }
      return;
    }

    // /t attach <session>
    if (userCommand.startsWith('attach ')) {
      const target = userCommand.slice(7).trim();
      const resolved = await resolveSessionProject(target);
      if (isAmbiguousSession(resolved)) {
        await interaction.reply(`\`${target}\` matches more than one project.`);
        return;
      }
      const opScope = resolved ? operationScopeForResolvedSession(resolved) : undefined;
      // Someone else's session is "No tmux session", as in Slack.
      if (!resolved || !(await mayReach(resolved.projectId)) || !await hasSession(target, opScope)) {
        await interaction.reply(`No tmux session \`${target}\`.`);
        return;
      }
      if (resolved.projectId) setActiveProjectId(discordUserId, resolved.projectId, 'main', 'discord');

      setNotificationTarget(target, { channel: interaction.channelId, userId: discordUserId }, 'discord', resolved.instanceId);
      const pane = await capturePaneForSlack(target, 200, opScope);
      const msg = await interaction.reply({ ...formatPaneForDiscord(pane, null, target), fetchReply: true });
      trackDiscordPaneMessage(interaction.channelId, msg.id, target, discordUserId, opScope);
      await addDiscordReactionHints(msg, pane);
      return;
    }

    // /t ctrl [command]
    if (userCommand.startsWith('ctrl')) {
      const ctrlCmd = userCommand.slice(4).trim();
      const projectId = getActiveProjectId(discordUserId);
      if (!projectId) {
        await interaction.reply('No active project. Use `/t switch <name>` first.');
        return;
      }
      const project = await prisma.project.findUnique({ where: { id: projectId }, include: { user: true } });
      if (!project) { await interaction.reply('Project not found.'); return; }
      if (!(await mayReach(project.id))) { await interaction.reply({ content: unreachable(project), ephemeral: true }); return; }

      const ctrlSession = sessionName(project.user.unixUsername, project.name, 'ctrl');
      const ctrlHost = project.instanceId;
      if (!await hasSession(ctrlSession, ctrlHost)) {
        await interaction.reply(`No ctrl session for \`${project.name}\`.`);
        return;
      }

      if (!ctrlCmd) {
        const pane = await capturePaneForSlack(ctrlSession, 200, ctrlHost);
        const msg = await interaction.reply({ ...formatPaneForDiscord(pane, null, ctrlSession), fetchReply: true });
        trackDiscordPaneMessage(interaction.channelId, msg.id, ctrlSession, discordUserId, ctrlHost);
        await addDiscordReactionHints(msg, pane);
        return;
      }

      const pane = await capturePaneForSlack(ctrlSession, 200, ctrlHost);
      const msg = await interaction.reply({ ...formatPaneForDiscord(pane, ctrlCmd, ctrlSession), fetchReply: true });
      trackDiscordPaneMessage(interaction.channelId, msg.id, ctrlSession, discordUserId, ctrlHost);
      const noEnter = ctrlCmd.startsWith('!');
      await sendKeys(ctrlSession, noEnter ? ctrlCmd.slice(1) : ctrlCmd, !noEnter, ctrlHost);
      await pollUntilStable(msg, ctrlSession, ctrlCmd, 30, ctrlHost);
      const finalPane = await capturePaneForSlack(ctrlSession, 200, ctrlHost);
      await addDiscordReactionHints(msg, finalPane);
      return;
    }

    // Default: send to active project's agent session
    const projectId = getActiveProjectId(discordUserId);
    let agentSession: string;
    let hostInstance: string | null = null;

    if (projectId) {
      const project = await prisma.project.findUnique({ where: { id: projectId }, include: { user: true } });
      if (project && !(await mayReach(project.id))) {
        await interaction.reply({ content: unreachable(project), ephemeral: true });
        return;
      }
      if (project) {
        agentSession = sessionName(project.user.unixUsername, project.name, 'agent');
        hostInstance = project.instanceId;
      } else {
        agentSession = `term-${discordUserId}`;
      }
    } else {
      const first = await prisma.project.findFirst({
        where: { archived: false, userId: termagUser.id, workflows: { some: { type: 'agent' } } },
        include: { user: true },
        orderBy: { name: 'asc' },
      });
      if (first) {
        guessActiveProjectId(discordUserId, first.id);
        agentSession = sessionName(first.user.unixUsername, first.name, 'agent');
        hostInstance = first.instanceId;
      } else {
        await interaction.reply('No projects with agent workflows. Create one in the termag web UI.');
        return;
      }
    }

    setNotificationTarget(agentSession, { channel: interaction.channelId, userId: discordUserId }, 'discord', hostInstance);

    if (!userCommand) {
      const pane = await capturePaneForSlack(agentSession, 200, hostInstance);
      const msg = await interaction.reply({ ...formatPaneForDiscord(pane, null, agentSession), fetchReply: true });
      trackDiscordPaneMessage(interaction.channelId, msg.id, agentSession, discordUserId, hostInstance);
      await addDiscordReactionHints(msg, pane);
      return;
    }

    // /t <command> — send to agent
    const noEnter = userCommand.startsWith('!');
    const keysToSend = noEnter ? userCommand.slice(1) : userCommand;

    // Defer reply since polling takes time
    await interaction.deferReply();
    const pane = await capturePaneForSlack(agentSession, 200, hostInstance);
    const msg = await interaction.editReply(formatPaneForDiscord(pane, userCommand, agentSession));
    trackDiscordPaneMessage(interaction.channelId, msg.id, agentSession, discordUserId, hostInstance);

    await sendKeys(agentSession, keysToSend, !noEnter, hostInstance);
    await pollUntilStable(msg, agentSession, userCommand, 30, hostInstance);
    const finalPane = await capturePaneForSlack(agentSession, 200, hostInstance);
    await addDiscordReactionHints(msg, finalPane);
  });

  // Emoji reaction handler
  client.on('messageReactionAdd', async (reaction, user) => {
    if (user.bot) return;

    // Hydrate partials
    if (reaction.partial) {
      try { await reaction.fetch(); } catch { return; }
    }
    if (reaction.message.partial) {
      try { await reaction.message.fetch(); } catch { return; }
    }

    const emoji = reaction.emoji.name;
    if (!emoji) return;
    const mapping = EMOJI_KEYS[emoji];
    if (!mapping) return;

    const key = `${reaction.message.channelId}:${reaction.message.id}`;
    const target = reactionTargets.get(key);
    if (!target) return;
    if (target.expiresAt < Date.now()) {
      reactionTargets.delete(key);
      return;
    }
    if (user.id !== target.userId) return;

    // Send keystroke
    if (mapping.keys || mapping.withEnter) {
      await sendKeys(target.sessionName, mapping.keys, mapping.withEnter, target.instanceId);
    }

    const label = emoji === '🔄' ? null : `(${emoji})`;
    const pane = await capturePaneForSlack(target.sessionName, 200, target.instanceId);
    const channel = reaction.message.channel;
    if (!channel.isTextBased() || !('send' in channel)) return;

    try {
      const msg = await (channel as any).send(formatPaneForDiscord(pane, label, target.sessionName));
      trackDiscordPaneMessage(target.channelId, msg.id, target.sessionName, target.userId, target.instanceId);

      await pollUntilStable(msg, target.sessionName, label, 30, target.instanceId);
      const finalPane = await capturePaneForSlack(target.sessionName, 200, target.instanceId);
      await addDiscordReactionHints(msg, finalPane);
    } catch (err) {
      console.error('[DISCORD] Reaction handler error:', (err as Error).message);
    }
  });
}
