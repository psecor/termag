import { exec } from 'child_process';
import { promisify } from 'util';
import { mkdir } from 'fs/promises';

const execAsync = promisify(exec);

// Project directory: /home/<username>/termag/projects/<project>/
export function projectDir(username: string, projectName: string): string {
  return `/home/${username}/termag/projects/${projectName}`;
}

export async function ensureProjectDir(username: string, projectName: string): Promise<string> {
  const dir = projectDir(username, projectName);
  await mkdir(dir, { recursive: true });
  // Initialize git repo if not already one
  try {
    await execAsync(`git -C ${shellEscape(dir)} rev-parse --git-dir 2>/dev/null`);
  } catch {
    await execAsync(`git init ${shellEscape(dir)}`);
  }
  return dir;
}

export function sessionName(username: string, project: string, role: 'agent' | 'ctrl' | 'data' | 'data-ctrl'): string {
  return `${username}-${project}-${role}`;
}

export async function hasSession(name: string): Promise<boolean> {
  try {
    await execAsync(`tmux has-session -t ${shellEscape(name)}`);
    return true;
  } catch {
    return false;
  }
}

export async function createSession(name: string, cwd: string = process.env.HOME ?? '/home'): Promise<void> {
  await execAsync(
    `tmux new-session -d -s ${shellEscape(name)} -c ${shellEscape(cwd)} -x 120 -y 30`
  );
  await execAsync(`tmux set-option -t ${shellEscape(name)} -w window-size largest`);
  await execAsync(`tmux set-option -t ${shellEscape(name)} history-limit 10000`);
}

export async function ensureSession(name: string, cwd?: string): Promise<boolean> {
  if (await hasSession(name)) return false; // already existed
  await createSession(name, cwd);
  return true; // newly created
}

// Kill existing session (if any) and create fresh in the given cwd
export async function recreateSession(name: string, cwd: string): Promise<void> {
  await killSession(name);
  await createSession(name, cwd);
}

export async function sendKeys(name: string, command: string, withEnter: boolean = true): Promise<void> {
  const target = shellEscape(name);
  const escaped = shellEscape(command.replace(/'/g, "'\\''"));
  await execAsync(`tmux send-keys -t ${target} -l ${escaped}`);
  if (withEnter) {
    await execAsync(`tmux send-keys -t ${target} Enter`);
  }
}

export async function capturePaneText(name: string): Promise<string> {
  try {
    const { stdout } = await execAsync(`tmux capture-pane -t ${shellEscape(name)} -p`);
    return stdout
      .split('\n')
      .map(l => l.trimEnd())
      .join('\n')
      .trimEnd();
  } catch {
    return '(unable to capture pane)';
  }
}

export async function foregroundCommand(name: string): Promise<string | null> {
  try {
    const { stdout } = await execAsync(
      `tmux list-panes -t ${shellEscape(name)} -F '#{pane_current_command}'`
    );
    return stdout.trim().split('\n')[0] ?? null;
  } catch {
    return null; // session doesn't exist
  }
}

export async function isAgentRunning(name: string): Promise<boolean> {
  const cmd = await foregroundCommand(name);
  if (!cmd) return false;
  const lc = cmd.toLowerCase();
  return ['claude', 'codex', 'auggie', 'node', 'python'].some(a => lc.includes(a))
    || lc === 'agent';
}

export async function listSessions(): Promise<string[]> {
  try {
    const { stdout } = await execAsync('tmux ls -F "#{session_name}"');
    return stdout.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

export async function renameSession(oldName: string, newName: string): Promise<void> {
  await execAsync(`tmux rename-session -t ${shellEscape(oldName)} ${shellEscape(newName)}`);
}

export async function killSession(name: string): Promise<void> {
  try {
    await execAsync(`tmux kill-session -t ${shellEscape(name)}`);
  } catch {
    // session may not exist, ignore
  }
}

function shellEscape(str: string): string {
  return `'${str.replace(/'/g, "'\\''")}'`;
}

// ── Slack-specific terminal helpers ────────────────────────────

const MAX_CAPTURE_LINES = 100;

/**
 * Capture pane content with ANSI stripping, suitable for Slack display.
 */
export async function capturePaneForSlack(sessionName: string): Promise<string> {
  try {
    const { stdout } = await execAsync(`tmux capture-pane -t ${shellEscape(sessionName)} -p`);
    let lines = stdout.split('\n').map((l: string) => l.trimEnd());
    // Remove trailing blank lines
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    if (lines.length > MAX_CAPTURE_LINES) {
      lines = ['…(output truncated)…', ...lines.slice(-MAX_CAPTURE_LINES)];
    }
    // Strip ANSI escape sequences
    return lines.join('\n')
      .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
      .replace(/\x1b[()][A-Z0-9]/g, '')
      .replace(/\x1b[^[\]]/g, '');
  } catch {
    return '(unable to capture pane)';
  }
}

/**
 * Format a Slack message showing terminal pane content.
 * Uses rich_text_preformatted blocks so terminal output is rendered literally.
 */
export function formatPaneForSlack(
  paneContent: string,
  command: string | null,
  sessionName: string,
  status: 'running' | 'done' | 'idle' | 'timeout'
): { blocks: any[]; text: string } {
  const headerText = command
    ? `⌨️ \`${command}\`  •  \`${sessionName}\``
    : `🖥️ \`${sessionName}\``;

  const blocks: any[] = [
    { type: 'section', text: { type: 'mrkdwn', text: headerText } },
    {
      type: 'rich_text',
      elements: [{
        type: 'rich_text_preformatted',
        elements: [{ type: 'text', text: paneContent || '(empty)' }],
      }],
    },
  ];

  if (status === 'running') {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '_Running…_' } });
  } else if (status === 'timeout') {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `_Command still running in \`${sessionName}\` — use \`/t\` to refresh_` },
    });
  }

  return { blocks, text: command ? `${command} — ${sessionName}` : sessionName };
}

/**
 * Poll tmux pane until output stabilizes, updating Slack message on changes.
 */
export async function pollUntilStable(
  client: { chat: { update: (args: Record<string, unknown>) => Promise<unknown> } },
  channelId: string,
  messageTs: string,
  sessionName: string,
  command: string | null,
  maxSeconds: number = 30,
): Promise<void> {
  const POLL_MS = 1500;
  const MIN_UPDATE_MS = 1100;
  const MAX_POLLS = Math.ceil((maxSeconds * 1000) / POLL_MS);
  const STABLE_THRESHOLD = 3;

  let lastContent: string | null = null;
  let lastSentContent: string | null = null;
  let lastSentAt = 0;
  let stableCount = 0;

  for (let i = 0; i < MAX_POLLS; i++) {
    await new Promise(resolve => setTimeout(resolve, POLL_MS));

    const pane = await capturePaneForSlack(sessionName);

    if (pane !== lastContent) {
      lastContent = pane;
      stableCount = 0;
      const now = Date.now();
      if (pane !== lastSentContent && now - lastSentAt >= MIN_UPDATE_MS) {
        try {
          await client.chat.update({
            channel: channelId,
            ts: messageTs,
            ...formatPaneForSlack(pane, command, sessionName, 'running'),
          });
          lastSentContent = pane;
          lastSentAt = Date.now();
        } catch (err) {
          console.error('[TERMINAL] Failed to update message:', (err as Error).message);
        }
      }
    } else {
      stableCount++;
      if (stableCount >= STABLE_THRESHOLD) {
        try {
          await client.chat.update({
            channel: channelId,
            ts: messageTs,
            ...formatPaneForSlack(pane, command, sessionName, 'done'),
          });
        } catch (err) {
          console.error('[TERMINAL] Failed to finalize message:', (err as Error).message);
        }
        return;
      }
    }
  }

  // Timeout
  try {
    const pane = await capturePaneForSlack(sessionName);
    await client.chat.update({
      channel: channelId,
      ts: messageTs,
      ...formatPaneForSlack(pane, command, sessionName, 'timeout'),
    });
  } catch (err) {
    console.error('[TERMINAL] Failed to update on timeout:', (err as Error).message);
  }
}
