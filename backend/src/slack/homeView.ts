/**
 * App Home View Builder
 *
 * Shows the logged-in user's termag projects with stoplights, plus local terminal sessions.
 */

import { PrismaClient } from '@prisma/client';
import { execSync } from 'child_process';
import type { WebClient } from '@slack/web-api';
import { getClaudeSessionStatus, listLocalSessions, getActiveLocalSession } from './lts';
import { getActiveProjectId } from './events';
import { sessionName } from '../services/tmux';
import { getStatus } from '../services/status';
import { resolveTermagUser } from './userMapping';

const prisma = new PrismaClient();
const STALE_MS = 10 * 60 * 1000;

function checkClaudeInSession(tmuxName: string): boolean | null {
  try {
    const out = execSync(
      `tmux list-panes -t '${tmuxName.replace(/'/g, "'\\''")}' -F '#{pane_current_command}' 2>/dev/null`,
      { encoding: 'utf-8', timeout: 2000 },
    );
    return out.split('\n').some(cmd => cmd.trim().toLowerCase().includes('claude'));
  } catch {
    return null;
  }
}

function stoplightEmoji(status: { claudeStatus: string | null; lastStatusAt: number | null }, claudeRunning: boolean | null): string {
  const { claudeStatus, lastStatusAt } = status;
  const age = lastStatusAt ? Date.now() - lastStatusAt : Infinity;

  if (claudeStatus === 'working') return '🟢';
  if (claudeStatus === 'waiting') return '🟡';
  if (claudeStatus === 'idle' && age <= STALE_MS) return '🔴';
  if (claudeRunning === true) return '🔘';
  if (claudeRunning === false) return '💤';
  return '⚪';
}

export async function publishHomeView(client: WebClient, slackUserId: string): Promise<void> {
  const view = await buildHomeView(slackUserId, client);
  await client.views.publish({ user_id: slackUserId, view });
}

async function buildHomeView(slackUserId: string, client?: WebClient) {
  // Resolve Slack user → termag user
  const termagUser = await resolveTermagUser(slackUserId, client);

  const blocks: any[] = [
    { type: 'header', text: { type: 'plain_text', text: '🤖 termag', emoji: true } },
    { type: 'section', text: { type: 'mrkdwn', text: 'Workspace manager with Claude Code integration.' } },
    { type: 'divider' },
    { type: 'header', text: { type: 'plain_text', text: '📁 Projects', emoji: true } },
  ];

  if (!termagUser) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '_Your Slack account is not linked to a termag user. Log in at the termag web UI first._' } });
  } else {
    // Only show this user's projects
    const projects = await prisma.project.findMany({
      where: { userId: termagUser.id, archived: false },
      include: { workflows: true, user: true },
      orderBy: { name: 'asc' },
    });

    if (projects.length === 0) {
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '_No projects. Create one in the termag web UI._' } });
    } else {
      const rows = await Promise.all(projects.map(async project => {
        const agentSessionN = sessionName(project.user.unixUsername, project.name, 'agent');

        const ltsStatus = getClaudeSessionStatus(agentSessionN);
        const webStatus = getStatus(agentSessionN);
        const statusInfo = (ltsStatus.lastStatusAt ?? 0) >= (webStatus.updatedAt?.getTime() ?? 0)
          ? ltsStatus
          : { claudeStatus: webStatus.status, lastStatusAt: webStatus.updatedAt?.getTime() ?? null };

        const needsCheck = !statusInfo.lastStatusAt
          || statusInfo.claudeStatus === 'not_running'
          || statusInfo.claudeStatus === 'idle'
          || Date.now() - (statusInfo.lastStatusAt ?? 0) > STALE_MS;

        let claudeRunning: boolean | null = null;
        if (needsCheck) {
          claudeRunning = checkClaudeInSession(agentSessionN);
          if (claudeRunning === null) claudeRunning = false;
        }

        return { project, statusInfo, claudeRunning };
      }));

      const activeId = getActiveProjectId(slackUserId);

      for (const { project, statusInfo, claudeRunning } of rows) {
        const light = stoplightEmoji(statusInfo, claudeRunning);
        const hasAgent = project.workflows.some(w => w.type === 'agent');
        const isActive = project.id === activeId;
        const name = isActive ? `:white_check_mark: *${project.name}*` : project.name;
        const label = `${light}  ${name}${hasAgent ? '' : ' _(no agent)_'}`;

        blocks.push({
          type: 'section',
          text: { type: 'mrkdwn', text: `${label}\n\`/home/${project.user.unixUsername}/termag/projects/${project.name}\`` },
          accessory: {
            type: 'button',
            text: { type: 'plain_text', text: isActive ? 'Active' : 'Attach', emoji: false },
            action_id: 'home_attach_project',
            value: project.id,
            ...(isActive ? {} : { style: 'primary' as const }),
          },
        });
      }
    }
  }

  // Local Terminal Sessions
  const localSessions = listLocalSessions();
  const activeLocal = getActiveLocalSession(slackUserId);

  blocks.push(
    { type: 'divider' },
    { type: 'header', text: { type: 'plain_text', text: '🖥️ Local Terminal Sessions', emoji: true } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: 'Local tmux sessions relayed from your Mac. Use `/t local <name>` to register.' }] },
  );

  if (localSessions.length === 0) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '_No local sessions. Use `/t local <name>` to connect one._' } });
  } else {
    for (const ls of localSessions) {
      const isActive = activeLocal === ls.name;
      const claudeRunning = ls.claudeStatus === 'not_running' ? false : null;
      const light = stoplightEmoji(ls, claudeRunning);
      const label = isActive ? `${light}  :white_check_mark: *${ls.name}*` : `${light}  ${ls.name}`;

      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: label },
        accessory: {
          type: 'button',
          text: { type: 'plain_text', text: isActive ? 'Active' : 'Attach', emoji: false },
          action_id: 'home_attach_local_session',
          value: ls.name,
          ...(isActive ? {} : { style: 'primary' as const }),
        },
      });
    }
  }

  blocks.push(
    { type: 'divider' },
    { type: 'context', elements: [{ type: 'mrkdwn', text: '✨ Powered by termag + Claude Code' }] },
  );

  return { type: 'home' as const, blocks };
}
