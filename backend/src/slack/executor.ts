/**
 * Claude Code CLI Executor
 *
 * Spawns `claude` with stream-json output for clean formatted DM/mention responses.
 * Used by the direct message flow (not the /t terminal flow).
 */

import { spawn } from 'child_process';
import { PrismaClient } from '@prisma/client';
import { projectDir, ensureProjectDir } from '../services/tmux';

const prisma = new PrismaClient();
const CLAUDE_TIMEOUT = (parseInt(process.env.CLAUDE_TIMEOUT_SECONDS ?? '120', 10)) * 1000;

export interface StreamChunk {
  type: 'stdout';
  chunk: string;
  fullOutput: string;
}

/**
 * Resolve the working directory for a Slack user.
 * Uses the user's active termag project directory, or falls back to home dir.
 */
export async function resolveWorkingDir(slackUserId: string, activeProjectId: string | null): Promise<string> {
  if (activeProjectId) {
    const project = await prisma.project.findUnique({
      where: { id: activeProjectId },
      include: { user: true },
    });
    if (project) {
      return await ensureProjectDir(project.user.unixUsername, project.name);
    }
  }
  return process.env.HOME ?? '/home/secorp';
}

/**
 * Execute a Claude Code command and return the response.
 */
export async function executeClaudeCommand(
  prompt: string,
  options: { workingDir: string; continueSession?: boolean },
  onStreamChunk?: ((data: StreamChunk) => void) | null,
): Promise<string> {
  const { workingDir, continueSession = false } = options;

  const args = [
    '--print',
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--verbose',
    '--permission-mode', 'bypassPermissions',
  ];

  if (continueSession) {
    args.push('--continue');
  }

  args.push(prompt);

  return new Promise((resolve, reject) => {
    let output = '';
    let errorOutput = '';
    let timedOut = false;
    let jsonBuffer = '';
    let accumulatedText = '';

    const proc = spawn('claude', args, {
      cwd: workingDir,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    proc.stdin.end();

    const timeoutId = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGTERM');
      setTimeout(() => {
        if (!proc.killed) proc.kill('SIGKILL');
      }, 5000);
    }, CLAUDE_TIMEOUT);

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
      clearTimeout(timeoutId);

      if (timedOut) {
        reject(new Error(`Request timed out after ${CLAUDE_TIMEOUT / 1000} seconds.`));
        return;
      }

      if (code === 0) {
        resolve(accumulatedText.trim() || output.trim() || 'Claude completed the request but returned no output.');
      } else {
        reject(new Error(parseClaudeError(errorOutput, code ?? 1)));
      }
    });

    proc.on('error', (error) => {
      clearTimeout(timeoutId);
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
