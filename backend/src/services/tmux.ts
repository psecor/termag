import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { ALL_PROCESS_NAMES } from '../providers/registry';
import { projectDirUnder, resolveProjectRoot } from './projectPaths';
import { ensureProjectRepo } from './gitRepo';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

// ── Local (in-process) sessions ──────────────────────────────
//
// Historically the orchestrator host also ran tmux for "legacy" projects with
// no box (Project.instanceId == null). A containerised orchestrator has no
// tmux, no engineer home directories and a read-only filesystem, so those code
// paths must fail fast with an actionable message instead of a confusing
// ENOENT/EACCES. Set LOCAL_SESSIONS_ENABLED=false on such deployments; every
// project there must be pinned to a box (or a self-managed agent).
//
// Read-only probes (hasSession, capturePaneText, listSessions, ...) degrade to
// "nothing here" so status/poller code keeps working; anything that would
// create or drive a local session throws LocalSessionsDisabledError.

export class LocalSessionsDisabledError extends Error {
  constructor(operation: string) {
    super(
      `${operation}: this orchestrator has no local tmux sessions (LOCAL_SESSIONS_ENABLED=false). ` +
      'Pin the project to a box or run a self-managed agent instead.',
    );
    this.name = 'LocalSessionsDisabledError';
  }
}

export function localSessionsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.LOCAL_SESSIONS_ENABLED ?? 'true').trim().toLowerCase();
  return !['false', '0', 'no', 'off'].includes(raw);
}

function assertLocalSessions(operation: string): void {
  if (!localSessionsEnabled()) throw new LocalSessionsDisabledError(operation);
}

// Working directory for a project's workstream under the historical
// /home/<username> root. Layout itself lives in ./projectPaths.
export function projectDir(
  username: string,
  projectName: string,
  workstream: string = 'main',
): string {
  return projectDirUnder(resolveProjectRoot({ ownerUnixUser: username }), projectName, workstream);
}

export interface ProjectPathProject {
  name: string;
  user: { unixUsername: string };
  instance?: { hostHome: string | null } | null;
}

// Same as projectDir, but honours the home directory the project's box
// reported in its `hello`. With no instance, or an instance that has not
// reported one, resolveProjectRoot falls back to /home/<unixUsername> and the
// result is byte-identical to projectDir(project.user.unixUsername, ...).
export function projectDirFor(
  project: ProjectPathProject,
  workstream: string = 'main',
): string {
  const root = resolveProjectRoot({
    ownerUnixUser: project.user.unixUsername,
    hostHome: project.instance?.hostHome,
  });
  return projectDirUnder(root, project.name, workstream);
}

export async function ensureProjectDir(
  username: string,
  projectName: string,
  opts: { seedWiki?: boolean; initialCommit?: boolean } = {},
): Promise<string> {
  assertLocalSessions('ensureProjectDir');
  const dir = projectDir(username, projectName);
  await mkdir(dir, { recursive: true });
  // Initialize git repo if not already one
  try {
    await execAsync(`git -C ${shellEscape(dir)} rev-parse --git-dir 2>/dev/null`);
  } catch {
    await execAsync(`git init ${shellEscape(dir)}`);
  }
  // Seed AGENTS.md + CLAUDE.md if absent. Not for a project that starts as a
  // repo clone: the checkout brings its own, and untracked files here would
  // make `git checkout` refuse (services/projectTemplates.ts).
  if (opts.seedWiki !== false) await initWikiFiles(dir, projectName, username);
  // Then a first commit carrying them, so `git worktree add ... HEAD`
  // (branching off into a new workstream) works without the user committing
  // by hand. Only when the caller knows the project has no repository: a local
  // first commit would own the branch name a clone's checkout creates.
  if (opts.initialCommit && opts.seedWiki !== false) {
    await ensureProjectRepo(dir).catch(err => {
      console.error(`[TMUX] Repo setup for ${dir} failed: ${(err as Error).message}`);
    });
  }
  return dir;
}

// Fallback path for project AGENTS.md seeding when the per-user agent is not
// connected. The agent is the primary path and bundles its own copy of the
// template; this just reuses that bundled file. From backend/dist/services/
// up three levels lands at the repo root, then agent/initial-AGENTS.md.
const WIKI_TEMPLATE_PATH = process.env.TERMAG_WIKI_TEMPLATE_PATH
  ?? join(__dirname, '../../..', 'agent', 'initial-AGENTS.md');

async function initWikiFiles(dir: string, slug: string, username: string): Promise<void> {
  const agentsPath = join(dir, 'AGENTS.md');
  if (existsSync(agentsPath)) return;

  let templateRaw: string;
  try {
    templateRaw = await readFile(WIKI_TEMPLATE_PATH, 'utf8');
  } catch {
    return; // Template not available — skip silently
  }

  const today = new Date().toISOString().slice(0, 10);
  const content = templateRaw
    .replace(/<slug>/g, slug)
    .replace(/<project name>/g, slug)
    .replace(/YYYY-MM-DD/g, today)
    .replace(/<handle>/g, username);

  await writeFile(agentsPath, content, 'utf8');

  const claudePath = join(dir, 'CLAUDE.md');
  if (!existsSync(claudePath)) {
    await writeFile(claudePath, '@AGENTS.md\n', 'utf8');
  }
}

// tmux replaces `.` and `:` in a new session's name with `_`, so
// `new-session -s first.last-x-agent` creates `first_last-x-agent`.
// Names are built already in that form, or an exact `=name` target misses.
export function tmuxSafeName(name: string): string {
  return name.replace(/[.:]/g, '_');
}

// tmux session name for a project's workstream role.
//   main:  <user>-<project>-<role>
//   other: <user>-<project>-<workstream>-<role>
//
// `main` is collapsed to preserve historical names for single-workstream
// projects; only when a project has additional workstreams do their session
// names carry the extra segment. Keep in sync with
// frontend/src/utils/sessionName.ts.
export function sessionName(
  username: string,
  project: string,
  role: 'agent' | 'ctrl' | 'data' | 'data-ctrl' | 'review',
  workstream: string = 'main',
): string {
  return tmuxSafeName(workstream === 'main'
    ? `${username}-${project}-${role}`
    : `${username}-${project}-${workstream}-${role}`);
}

// Session names are "<unixUsername>-<project>[-<workstream>]-<role>" and a
// unixUsername may itself contain hyphens, so match the FULL username as a
// prefix. Parsing the first hyphen segment instead would both reject
// hyphenated users on their own sessions and let a prefix name ("alice")
// satisfy "alice-smith-…".
export function sessionBelongsToUser(session: string, unixUsername: string): boolean {
  const owner = tmuxSafeName(unixUsername);
  return session === owner || session.startsWith(`${owner}-`);
}

/**
 * A tmux target that names exactly one session. A bare name prefix-matches
 * when no session has that exact name, so killing a dead `u-p-agent` would
 * kill `u-p-agent2-agent` instead (the trap behind #220).
 */
export function exactSessionTarget(name: string): string {
  return `=${name}`;
}

export async function hasSession(name: string): Promise<boolean> {
  if (!localSessionsEnabled()) return false;
  try {
    await execAsync(`tmux has-session -t ${shellEscape(exactSessionTarget(name))}`);
    return true;
  } catch {
    return false;
  }
}

export async function createSession(name: string, cwd: string = process.env.HOME ?? '/home'): Promise<void> {
  assertLocalSessions('createSession');
  await execAsync(
    `tmux new-session -d -s ${shellEscape(name)} -c ${shellEscape(cwd)} -x 120 -y 30`
  );
  await execAsync(`tmux set-option -t ${shellEscape(name)} -w window-size largest`);
  await execAsync(`tmux set-option -t ${shellEscape(name)} history-limit 10000`);
  // Let tmux copy operations (copy-mode y/M-w, mouse drag-end) emit OSC 52 so
  // selections reach the browser clipboard via xterm.js. set-clipboard is a
  // server option; -g applies it to all sessions.
  await execAsync(`tmux set-option -g set-clipboard on`);
  await execAsync(`tmux set-option -ga terminal-features ',xterm-256color:clipboard'`);
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

/** Pure argv for `tmux send-keys -l` — exported for tests. */
export function sendKeysArgv(name: string, text: string): string[] {
  return ['send-keys', '-t', name, '-l', '--', text];
}

export async function sendKeys(name: string, command: string, withEnter: boolean = true): Promise<void> {
  assertLocalSessions('sendKeys');
  // argv via execFile, never a shell string: the shell version escaped `'`
  // twice and typed `'\''` for every apostrophe. `--` ends tmux
  // option parsing so text starting with `-` is typed too; `-l` applies to
  // every argument, so Enter is a separate call.
  await execFileAsync('tmux', sendKeysArgv(name, command));
  if (withEnter) {
    await execFileAsync('tmux', ['send-keys', '-t', name, 'Enter']);
  }
}

export async function capturePaneText(name: string): Promise<string> {
  if (!localSessionsEnabled()) return '(unable to capture pane)';
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
  if (!localSessionsEnabled()) return null;
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
  return ALL_PROCESS_NAMES.some(a => lc.includes(a))
    || ['node', 'python'].some(a => lc.includes(a));
}

export async function listSessions(): Promise<string[]> {
  if (!localSessionsEnabled()) return [];
  try {
    const { stdout } = await execAsync('tmux ls -F "#{session_name}"');
    return stdout.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

export async function renameSession(oldName: string, newName: string): Promise<void> {
  assertLocalSessions('renameSession');
  await execAsync(`tmux rename-session -t ${shellEscape(`=${oldName}`)} ${shellEscape(newName)}`);
}

export async function killSession(name: string): Promise<void> {
  if (!localSessionsEnabled()) return; // nothing local to kill
  try {
    await execAsync(`tmux kill-session -t ${shellEscape(exactSessionTarget(name))}`);
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
// Normalize raw `tmux capture-pane` stdout for Slack: trim trailing blank
// lines, cap length, strip ANSI. Shared by the in-process capture below and
// the agent-routed capture in slack/tmuxAgent.ts.
export function cleanPaneText(stdout: string): string {
  let lines = stdout.split('\n').map((l: string) => l.trimEnd());
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  if (lines.length > MAX_CAPTURE_LINES) {
    lines = ['…(output truncated)…', ...lines.slice(-MAX_CAPTURE_LINES)];
  }
  return lines.join('\n')
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1b[()][A-Z0-9]/g, '')
    .replace(/\x1b[^[\]]/g, '');
}

export async function capturePaneForSlack(sessionName: string): Promise<string> {
  if (!localSessionsEnabled()) return '(unable to capture pane)';
  try {
    const { stdout } = await execAsync(`tmux capture-pane -t ${shellEscape(sessionName)} -p`);
    return cleanPaneText(stdout);
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
