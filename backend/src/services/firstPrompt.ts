// A new workstream's agent can start on a prompt the user wrote (the PR
// overlay's "New workstream for #N…"). Like a spawn's
// brief, the text goes in a file on the box and the agent reads it through
// its provider's promptLaunch, so it never goes through shell quoting.

import { PROVIDERS } from '../providers/registry';

const PROMPT_DIR = '.termag/first-prompts';
const SAFE_SESSION = /^[\w.-]+$/;
/** Longer than any prompt typed into the form; a bound on what is written to the box. */
export const FIRST_PROMPT_MAX = 8000;

function promptFile(session: string): string {
  if (!SAFE_SESSION.test(session) || session.startsWith('.')) throw new Error('unsafe session name');
  return `${session}.md`;
}

/** Where write-file puts the prompt (the agent applies its path_remap to this). */
export function firstPromptPath(home: string, session: string): string {
  return `${home.replace(/\/+$/, '')}/${PROMPT_DIR}/${promptFile(session)}`;
}

/** The launch that starts on the prompt, naming the file through the pane's $HOME; null when the provider cannot. */
export function firstPromptLaunchCommand(provider: string, session: string): string | null {
  const launch = PROVIDERS[provider]?.promptLaunch;
  return launch ? launch(`"$HOME/${PROMPT_DIR}/${promptFile(session)}"`) : null;
}

/** A request body's prompt: absent or blank is none; anything else must be a string within the bound. */
export function parseFirstPrompt(value: unknown): { ok: true; prompt: string | null } | { ok: false; error: string } {
  if (value == null) return { ok: true, prompt: null };
  if (typeof value !== 'string') return { ok: false, error: 'prompt must be a string' };
  const prompt = value.trim();
  if (prompt.length > FIRST_PROMPT_MAX) return { ok: false, error: `prompt must be at most ${FIRST_PROMPT_MAX} characters` };
  return { ok: true, prompt: prompt || null };
}
