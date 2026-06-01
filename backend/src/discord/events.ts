/**
 * Discord Event Handlers
 *
 * Handles /t slash command and emoji reactions for terminal control.
 */

import { Client, ChatInputCommandInteraction, Message } from 'discord.js';
import { PrismaClient } from '@prisma/client';
import { resolveDiscordUser } from './userMapping';
import { formatPaneForDiscord } from './formatting';
import {
  sessionName, projectDir, hasSession, sendKeys,
  capturePaneForSlack, listSessions as tmuxListSessions,
} from '../services/tmux';
import { setNotificationTarget } from '../slack/lts';
import { getActiveProjectId, setActiveProjectId } from '../slack/events';
import { isAgentConnected, sendToAgent } from '../services/agentRegistry';
import { ensureAgentSessionsAndLaunch } from '../services/agentRuntime';
import { ensureMainWorkstream } from '../services/workstreams';

const prisma = new PrismaClient();

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
  expiresAt: number;
}
const reactionTargets = new Map<string, ReactionTarget>();
const REACTION_TTL = 60 * 60 * 1000;

export function trackDiscordPaneMessage(channelId: string, messageId: string, tmuxSession: string, userId: string): void {
  const now = Date.now();
  for (const [key, val] of reactionTargets) {
    if (val.expiresAt < now) reactionTargets.delete(key);
  }
  reactionTargets.set(`${channelId}:${messageId}`, {
    sessionName: tmuxSession,
    userId,
    channelId,
    expiresAt: now + REACTION_TTL,
  });
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
): Promise<void> {
  let lastContent = '';
  let stableCount = 0;

  for (let i = 0; i < maxPolls; i++) {
    await new Promise(r => setTimeout(r, 1500));
    const pane = await capturePaneForSlack(tmuxSession);

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

    // /t create <project-name>
    if (userCommand.startsWith('create ')) {
      const projectName = userCommand.slice(7).trim();
      if (!/^[a-zA-Z0-9_-]+$/.test(projectName)) {
        await interaction.reply('Project name must be alphanumeric with dashes/underscores only.');
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
          });
        } else {
          await interaction.reply(`Project \`${projectName}\` created but agent is not connected — tmux sessions not started.`);
          return;
        }

        // Create Slack channel (if Slack is configured)
        const { createProjectChannel } = await import('../slack/channels');
        createProjectChannel(projectName, termagUser.slackUserId ?? undefined).then(channelId => {
          if (channelId) {
            prisma.project.update({
              where: { id: project.id },
              data: { slackChannelId: channelId },
            }).catch(err => console.error('[DISCORD] Failed to save channel ID:', err.message));
          }
        });

        setActiveProjectId(discordUserId, project.id);
        setNotificationTarget(agentSession, { channel: interaction.channelId, userId: discordUserId }, 'discord');
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
      const project = await prisma.project.findFirst({
        where: { name: projectName, userId: termagUser.id, archived: false },
        include: { workflows: true },
      });
      if (!project) {
        await interaction.reply(`No project \`${projectName}\`. Use \`/t projects\` to list.`);
        return;
      }
      setActiveProjectId(discordUserId, project.id);
      const agentSession = sessionName(username, project.name, 'agent');
      setNotificationTarget(agentSession, { channel: interaction.channelId, userId: discordUserId }, 'discord');
      const pane = await capturePaneForSlack(agentSession);
      const msg = await interaction.reply({ ...formatPaneForDiscord(pane, null, agentSession), fetchReply: true });
      trackDiscordPaneMessage(interaction.channelId, msg.id, agentSession, discordUserId);
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
      if (!await hasSession(target)) {
        await interaction.reply(`No tmux session \`${target}\`.`);
        return;
      }
      const projects = await prisma.project.findMany({ where: { archived: false }, include: { user: true } });
      const match = projects.find(p => sessionName(p.user.unixUsername, p.name, 'agent') === target);
      if (match) setActiveProjectId(discordUserId, match.id);

      setNotificationTarget(target, { channel: interaction.channelId, userId: discordUserId }, 'discord');
      const pane = await capturePaneForSlack(target);
      const msg = await interaction.reply({ ...formatPaneForDiscord(pane, null, target), fetchReply: true });
      trackDiscordPaneMessage(interaction.channelId, msg.id, target, discordUserId);
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

      const ctrlSession = sessionName(project.user.unixUsername, project.name, 'ctrl');
      if (!await hasSession(ctrlSession)) {
        await interaction.reply(`No ctrl session for \`${project.name}\`.`);
        return;
      }

      if (!ctrlCmd) {
        const pane = await capturePaneForSlack(ctrlSession);
        const msg = await interaction.reply({ ...formatPaneForDiscord(pane, null, ctrlSession), fetchReply: true });
        trackDiscordPaneMessage(interaction.channelId, msg.id, ctrlSession, discordUserId);
        await addDiscordReactionHints(msg, pane);
        return;
      }

      const pane = await capturePaneForSlack(ctrlSession);
      const msg = await interaction.reply({ ...formatPaneForDiscord(pane, ctrlCmd, ctrlSession), fetchReply: true });
      trackDiscordPaneMessage(interaction.channelId, msg.id, ctrlSession, discordUserId);
      const noEnter = ctrlCmd.startsWith('!');
      await sendKeys(ctrlSession, noEnter ? ctrlCmd.slice(1) : ctrlCmd, !noEnter);
      await pollUntilStable(msg, ctrlSession, ctrlCmd, 30);
      const finalPane = await capturePaneForSlack(ctrlSession);
      await addDiscordReactionHints(msg, finalPane);
      return;
    }

    // Default: send to active project's agent session
    const projectId = getActiveProjectId(discordUserId);
    let agentSession: string;

    if (projectId) {
      const project = await prisma.project.findUnique({ where: { id: projectId }, include: { user: true } });
      if (project) {
        agentSession = sessionName(project.user.unixUsername, project.name, 'agent');
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
        setActiveProjectId(discordUserId, first.id);
        agentSession = sessionName(first.user.unixUsername, first.name, 'agent');
      } else {
        await interaction.reply('No projects with agent workflows. Create one in the termag web UI.');
        return;
      }
    }

    setNotificationTarget(agentSession, { channel: interaction.channelId, userId: discordUserId }, 'discord');

    // /t (no args) — pane screenshot
    if (!userCommand) {
      const pane = await capturePaneForSlack(agentSession);
      const msg = await interaction.reply({ ...formatPaneForDiscord(pane, null, agentSession), fetchReply: true });
      trackDiscordPaneMessage(interaction.channelId, msg.id, agentSession, discordUserId);
      await addDiscordReactionHints(msg, pane);
      return;
    }

    // /t <command> — send to agent
    const noEnter = userCommand.startsWith('!');
    const keysToSend = noEnter ? userCommand.slice(1) : userCommand;

    // Defer reply since polling takes time
    await interaction.deferReply();
    const pane = await capturePaneForSlack(agentSession);
    const msg = await interaction.editReply(formatPaneForDiscord(pane, userCommand, agentSession));
    trackDiscordPaneMessage(interaction.channelId, msg.id, agentSession, discordUserId);

    await sendKeys(agentSession, keysToSend, !noEnter);
    await pollUntilStable(msg, agentSession, userCommand, 30);
    const finalPane = await capturePaneForSlack(agentSession);
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
      await sendKeys(target.sessionName, mapping.keys, mapping.withEnter);
    }

    // Post updated pane
    const label = emoji === '🔄' ? null : `(${emoji})`;
    const pane = await capturePaneForSlack(target.sessionName);
    const channel = reaction.message.channel;
    if (!channel.isTextBased() || !('send' in channel)) return;

    try {
      const msg = await (channel as any).send(formatPaneForDiscord(pane, label, target.sessionName));
      trackDiscordPaneMessage(target.channelId, msg.id, target.sessionName, target.userId);

      // Poll for stability then add hints
      await pollUntilStable(msg, target.sessionName, label, 30);
      const finalPane = await capturePaneForSlack(target.sessionName);
      await addDiscordReactionHints(msg, finalPane);
    } catch (err) {
      console.error('[DISCORD] Reaction handler error:', (err as Error).message);
    }
  });
}
