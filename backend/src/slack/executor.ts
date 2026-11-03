/**
 * Claude Code CLI Executor
 *
 * Spawns `claude` with stream-json output for clean formatted DM/mention responses.
 * Used by the direct message flow (not the /t terminal flow).
 */

import { spawn } from 'child_process';
import { homedir } from 'os';
import { prisma } from '../db';
import { projectDir, ensureProjectDir } from '../services/tmux';

const CLAUDE_TIMEOUT = (parseInt(process.env.CLAUDE_TIMEOUT_SECONDS ?? '120', 10)) * 1000;

export interface StreamChunk {
  type: 'stdout';
  chunk: string;
  fullOutput: string;
}

/**
 * The process groups of the claude runs still going. Each run is detached (its
 * own group, so Stop reaches the commands it started), and a detached group is
 * not ended with this process: on exit, whatever is left is killed, or an
 * orphan could keep writing to a session the next process resumes.
 */
const liveGroups = new Set<number>();

/** Whether anything in the process group is still running (a tool child can outlive claude). */
function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Forget empty groups, so a pid reused later is never signalled. */
function forgetEmptyGroups(): void {
  for (const pid of liveGroups) if (!groupAlive(pid)) liveGroups.delete(pid);
}
setInterval(forgetEmptyGroups, 30_000).unref();

process.once('exit', () => {
  for (const pid of liveGroups) {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
  }
});

/** The run was ended through `signal` (the Slack agent's Stop button). */
export class ClaudeRunStopped extends Error {
  constructor() {
    super('Stopped.');
  }
}

/**
 * Resolve the working directory for a Slack user.
 * Uses the user's active termag project directory, or falls back to home dir.
 */
export async function resolveWorkingDir(
  slackUserId: string,
  activeProjectId: string | null,
  workstream: string = 'main',
): Promise<string> {
  if (activeProjectId) {
    const project = await prisma.project.findUnique({
      where: { id: activeProjectId },
      include: { user: true },
    });
    if (project) {
      const root = await ensureProjectDir(project.user.unixUsername, project.name);
      // Non-main workstreams are git worktrees under <root>/.worktrees/<name>;
      // they exist iff the workstream does, so no ensure step.
      return workstream === 'main' ? root : projectDir(project.user.unixUsername, project.name, workstream);
    }
  }
  return process.env.HOME ?? homedir();
}

/**
 * Execute a Claude Code command and return the response.
 */
export async function executeClaudeCommand(
  prompt: string,
  options: Parameters<typeof runClaude>[1],
  onStreamChunk?: ((data: StreamChunk) => void) | null,
): Promise<string> {
  try {
    return await runClaude(prompt, options, onStreamChunk);
  } catch (err) {
    const message = (err as Error).message;
    // An older claude CLI has no --fork-session, and a session Claude no longer
    // has (its files went with a container, say) cannot be resumed: either way
    // the turn starts fresh, and the caller is told so it can say so.
    const noFork = options.forkSession && /fork-session/.test(message);
    const gone = options.resumeSessionId && /No conversation found/i.test(message);
    if (!noFork && !gone) throw err;
    console.warn(`[EXECUTOR] ${noFork ? 'claude does not know --fork-session' : 'the session to resume is gone'}; starting a fresh session`);
    options.onFreshStart?.();
    return runClaude(prompt, { ...options, resumeSessionId: undefined, forkSession: false }, onStreamChunk);
  }
}

async function runClaude(
  prompt: string,
  options: {
    workingDir: string;
    continueSession?: boolean;
    /** A session id from `onSessionId`; Claude only finds it from the same workingDir. */
    resumeSessionId?: string;
    /** With resumeSessionId: continue under a new id, leaving the original to its other run. */
    forkSession?: boolean;
    signal?: AbortSignal;
    onSessionId?: (sessionId: string) => void;
    appendSystemPrompt?: string;
    timeoutMs?: number;
    /** Called when a resume could not happen and the turn starts a fresh session instead. */
    onFreshStart?: () => void;
  },
  onStreamChunk?: ((data: StreamChunk) => void) | null,
): Promise<string> {
  const {
    workingDir, continueSession = false, resumeSessionId, forkSession = false, signal, onSessionId,
    appendSystemPrompt, timeoutMs = CLAUDE_TIMEOUT,
  } = options;
  if (signal?.aborted) return Promise.reject(new ClaudeRunStopped());

  const args = [
    '--print',
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--verbose',
    '--permission-mode', 'bypassPermissions',
  ];

  if (appendSystemPrompt) {
    args.push('--append-system-prompt', appendSystemPrompt);
  }
  if (resumeSessionId) {
    args.push('--resume', resumeSessionId);
    if (forkSession) args.push('--fork-session');
  } else if (continueSession) {
    args.push('--continue');
  }

  args.push(prompt);

  return new Promise((resolve, reject) => {
    let output = '';
    let errorOutput = '';
    let timedOut = false;
    let stopped = false;
    let jsonBuffer = '';
    let accumulatedText = '';
    let sessionId: string | null = null;
    // Claude reports some failures (an expired login) only in its result event.
    let resultError: string | null = null;

    const proc = spawn('claude', args, {
      cwd: workingDir,
      env: { ...process.env, ANTHROPIC_API_KEY: undefined },
      stdio: ['pipe', 'pipe', 'pipe'],
      // Its own process group, so Stop and the timeout also end the commands it runs.
      detached: true,
    });
    if (proc.pid) liveGroups.add(proc.pid);

    proc.stdin.end();

    const killGroup = (sig: NodeJS.Signals) => {
      try {
        if (proc.pid) process.kill(-proc.pid, sig);
      } catch {
        proc.kill(sig);
      }
    };
    const terminate = () => {
      killGroup('SIGTERM');
      // The whole group, whether or not claude itself is gone: a tool child that
      // ignores SIGTERM would otherwise outlive Stop. An empty group is a no-op.
      setTimeout(() => killGroup('SIGKILL'), 5000);
    };
    const timeoutId = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    const onAbort = () => {
      stopped = true;
      terminate();
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    proc.stdout.on('data', (data: Buffer) => {
      const chunk = data.toString();
      output += chunk;
      jsonBuffer += chunk;

      const lines = jsonBuffer.split('\n');
      jsonBuffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.type === 'result' && event.is_error) {
            const why = typeof event.result === 'string' && event.result ? event.result : event.errors?.[0];
            if (typeof why === 'string' && why) resultError = why;
          }
          if (!sessionId && typeof event.session_id === 'string') {
            sessionId = event.session_id;
            try { onSessionId?.(event.session_id); } catch { /* ignore callback errors */ }
          }
          // Text before and after a tool call arrives as separate blocks with nothing between them.
          if (event.type === 'stream_event' && event.event?.type === 'content_block_start'
              && event.event.content_block?.type === 'text' && accumulatedText && !accumulatedText.endsWith('\n\n')) {
            const gap = accumulatedText.endsWith('\n') ? '\n' : '\n\n';
            accumulatedText += gap;
            try { onStreamChunk?.({ type: 'stdout', chunk: gap, fullOutput: accumulatedText }); } catch { /* ignore callback errors */ }
          }
          if (event.type === 'stream_event' && event.event?.type === 'content_block_delta') {
            const textChunk = event.event.delta?.text;
            if (textChunk) {
              accumulatedText += textChunk;
              if (onStreamChunk) {
                try {
                  onStreamChunk({ type: 'stdout', chunk: textChunk, fullOutput: accumulatedText });
                } catch {
                  // ignore callback errors
                }
              }
            }
          }
        } catch {
          // ignore JSON parse errors for partial lines
        }
      }
    });

    proc.stderr.on('data', (data: Buffer) => {
      errorOutput += data.toString();
    });

    proc.on('close', (code) => {
      // Kept while a child in the group lives on; the sweep forgets it once empty.
      if (proc.pid && !groupAlive(proc.pid)) liveGroups.delete(proc.pid);
      clearTimeout(timeoutId);
      signal?.removeEventListener('abort', onAbort);
      console.log(`[EXECUTOR] claude exited code=${code} timedOut=${timedOut} stopped=${stopped} accumulatedText=${accumulatedText.length}chars stderr="${errorOutput.slice(0, 200)}"`);

      if (stopped) {
        reject(new ClaudeRunStopped());
        return;
      }
      if (timedOut) {
        const secs = timeoutMs / 1000;
        reject(new Error(`Request timed out after ${secs >= 120 && secs % 60 === 0 ? `${secs / 60} minutes` : `${secs} seconds`}.`));
        return;
      }

      if (code === 0) {
        resolve(accumulatedText.trim() || output.trim() || 'Claude completed the request but returned no output.');
      } else {
        reject(new Error(parseClaudeError(errorOutput.trim() ? errorOutput : resultError ?? '', code ?? 1)));
      }
    });

    proc.on('error', (error) => {
      if (proc.pid) liveGroups.delete(proc.pid);
      clearTimeout(timeoutId);
      signal?.removeEventListener('abort', onAbort);
      console.error(`[EXECUTOR] spawn error: ${error.message}`);
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(new Error('Claude CLI not found. Make sure `claude` is installed and in PATH.'));
      } else {
        reject(new Error(`Failed to execute Claude: ${error.message}`));
      }
    });
  });
}

function parseClaudeError(stderr: string, exitCode: number): string {
  const lower = stderr.toLowerCase();
  if (lower.includes('api key') || lower.includes('unauthorized')) {
    return 'API authentication failed. ANTHROPIC_API_KEY may be invalid.';
  }
  if (lower.includes('rate limit') || lower.includes('too many requests')) {
    return 'Rate limited by Anthropic API. Please wait and try again.';
  }
  if (lower.includes('overloaded') || lower.includes('capacity')) {
    return 'Claude is currently overloaded. Try again shortly.';
  }
  if (lower.includes('context') || lower.includes('too long')) {
    return 'Conversation too long. Try starting a `new session`.';
  }
  if (stderr.trim()) {
    const truncated = stderr.length > 500 ? stderr.substring(0, 500) + '...' : stderr;
    return `Claude error (exit ${exitCode}): ${truncated}`;
  }
  return `Claude exited with code ${exitCode}`;
}
