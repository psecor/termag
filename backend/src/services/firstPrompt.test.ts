import { describe, it, expect } from 'vitest';
import { FIRST_PROMPT_MAX, firstPromptLaunchCommand, firstPromptPath, parseFirstPrompt } from './firstPrompt';

describe('a new workstream\'s first prompt', () => {
  it('lives in one file per agent session, read through the pane\'s $HOME', () => {
    expect(firstPromptPath('/home/u/', 'u-termag-agent-termag-pr1')).toBe('/home/u/.termag/first-prompts/u-termag-agent-termag-pr1.md');
    expect(firstPromptLaunchCommand('claude', 'u-termag-agent-ws')).toBe('claude "$(cat "$HOME/.termag/first-prompts/u-termag-agent-ws.md")"');
    expect(firstPromptLaunchCommand('devin', 'u-termag-agent-ws')).toBe('devin --prompt-file "$HOME/.termag/first-prompts/u-termag-agent-ws.md"');
  });
  it('is not offered to a provider that cannot start on one, and refuses an unsafe session name', () => {
    expect(firstPromptLaunchCommand('codex', 'u-termag-agent-ws')).toBeNull();
    expect(() => firstPromptPath('/home/u', '../x')).toThrow();
    expect(() => firstPromptPath('/home/u', 'a b')).toThrow();
  });
  it('parses a request body\'s prompt: absent or blank is none', () => {
    expect(parseFirstPrompt(undefined)).toEqual({ ok: true, prompt: null });
    expect(parseFirstPrompt('   ')).toEqual({ ok: true, prompt: null });
    expect(parseFirstPrompt(' hi ')).toEqual({ ok: true, prompt: 'hi' });
    expect(parseFirstPrompt(3).ok).toBe(false);
    expect(parseFirstPrompt('x'.repeat(FIRST_PROMPT_MAX + 1)).ok).toBe(false);
  });
});
