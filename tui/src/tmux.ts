import { execFile, execFileSync } from 'node:child_process';

/** True when the TUI itself is running inside a tmux client. */
export function insideTmux(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.TMUX);
}

/** Names of the sessions on this host's default tmux server (empty if none / no tmux). */
export function listLocalSessions(): Promise<Set<string>> {
  return new Promise((resolve) => {
    execFile('tmux', ['list-sessions', '-F', '#S'], { timeout: 3000 }, (err, stdout) => {
      if (err) { resolve(new Set()); return; }
      resolve(new Set(stdout.split('\n').map(s => s.trim()).filter(Boolean)));
    });
  });
}

/** The tmux session the TUI is running in, or null. */
export function currentSession(): string | null {
  try {
    return execFileSync('tmux', ['display-message', '-p', '#S'], { encoding: 'utf8', timeout: 3000 }).trim() || null;
  } catch { return null; }
}

/** Switch the current tmux client to another session (TUI keeps running). */
export function switchClient(session: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('tmux', ['switch-client', '-t', session], { timeout: 3000 }, (err, _out, stderr) => {
      if (err) reject(new Error(stderr?.trim() || err.message)); else resolve();
    });
  });
}

export type BindResult = 'bound' | 'occupied' | 'failed';

/**
 * Bind `prefix + key` to switch back to the TUI's session, so a user who
 * jumped into an agent pane has a one-chord way home. Global key table, so it
 * persists for the tmux server's lifetime. A key the user already bound to
 * something else is left alone ('occupied') — rebinding would clobber their
 * config until the server restarts; set `returnKey` in tui.json to another key.
 */
export function bindReturnKey(key: string, tuiSession: string): BindResult {
  try {
    let existing = '';
    try { existing = execFileSync('tmux', ['list-keys', '-T', 'prefix', key], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).trim(); } catch { /* unbound */ }
    if (existing && !existing.includes('switch-client')) return 'occupied';
    execFileSync('tmux', ['bind-key', key, 'switch-client', '-t', tuiSession], { stdio: 'ignore', timeout: 3000 });
    return 'bound';
  } catch { return 'failed'; }
}
