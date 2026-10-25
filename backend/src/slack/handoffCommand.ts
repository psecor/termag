/**
 * `/t handoff [clear|compact|restart] [agent]`: hand
 * the channel's (or the active) project and workstream's agent off. The
 * parse is pure; slackHandoff calls the same startHandoff as every surface.
 */
import type { User } from '@prisma/client';
import { HANDOFF_MODES, type HandoffMode } from '../services/agentHandoff';
import { PROVIDERS } from '../providers/registry';
import { startHandoff } from '../routes/handoffs';

export const HANDOFF_USAGE = 'Usage: `/t handoff [clear|compact|restart] [agent]` — e.g. `/t handoff`, `/t handoff restart cursor`.';

function agentNamed(word: string): string | undefined {
  return Object.values(PROVIDERS).find(p => p.id === word || p.displayName.toLowerCase() === word)?.id;
}

/**
 * `handoff` alone, or followed by a mode or an agent name. Anything else
 * (`handoff please write the docs`, `handoffs …`) is an instruction like any
 * other and goes to the agent; only the forms the command takes are claimed.
 */
export function isHandoffCommand(text: string): boolean {
  const words = text.trim().split(/\s+/);
  if (words[0].toLowerCase() !== 'handoff') return false;
  const next = words[1]?.toLowerCase();
  return !next || HANDOFF_MODES.includes(next as HandoffMode) || !!agentNamed(next);
}

export type SlackHandoffArgs = { ok: true; mode: HandoffMode; provider?: string } | { ok: false; error: string };

/** The words after `handoff`: an optional mode, then an optional agent (by id or display name). */
export function parseSlackHandoff(text: string): SlackHandoffArgs {
  const words = text.trim().split(/\s+/).slice(1).map(w => w.toLowerCase()).filter(Boolean);
  let mode: HandoffMode = 'clear';
  if (words[0] && HANDOFF_MODES.includes(words[0] as HandoffMode)) mode = words.shift() as HandoffMode;
  let provider: string | undefined;
  if (words.length) {
    const word = words.shift()!;
    provider = agentNamed(word);
    if (!provider) return { ok: false, error: `No agent called "${word}". ${HANDOFF_USAGE}` };
    // Naming an agent means starting it: only a restart can.
    mode = 'restart';
  }
  if (words.length) return { ok: false, error: HANDOFF_USAGE };
  return { ok: true, mode, ...(provider ? { provider } : {}) };
}

/** The message posted back: what will happen, or why it will not. */
export async function slackHandoff(user: User, target: { projectId: string; projectName: string; workstream: string }, text: string): Promise<string> {
  const parsed = parseSlackHandoff(text);
  if (!parsed.ok) return parsed.error;
  const where = `\`${target.projectName}${target.workstream === 'main' ? '' : `/${target.workstream}`}\``;
  const result = await startHandoff(user, { projectId: target.projectId, workstream: target.workstream },
    { mode: parsed.mode, ...(parsed.provider ? { provider: parsed.provider } : {}) }, { initiator: 'person', surface: 'slack' });
  if (result.status >= 400) {
    const error = (result.body as { error?: unknown } | null)?.error;
    return `Could not hand off ${where}: ${typeof error === 'string' ? error : `HTTP ${result.status}`}`;
  }
  const body = result.body as { handoff: { mode: string; toProvider: string | null }; note?: string };
  const then = body.handoff.mode === 'restart'
    ? `the pane restarts${body.handoff.toProvider ? ` on ${PROVIDERS[body.handoff.toProvider]?.displayName ?? body.handoff.toProvider}` : ''}`
    : `its context is ${body.handoff.mode === 'clear' ? 'cleared' : 'compacted'}`;
  const lines = [`Handing off ${where}: when its turn ends the agent writes a handoff, then ${then} and the next agent starts on it.`];
  if (body.note) lines.push(`_${body.note}_`);
  return lines.join('\n');
}
