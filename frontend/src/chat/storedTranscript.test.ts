import { describe, expect, it } from 'vitest';
import { commandLine, fromHistory } from './sdkChat';
// The orchestrator's stored view of a real Claude Code 2.1.309 session
// (backend/src/services/chatTranscriptView.test.ts keeps this file in step).
import entries from './fixtures/stored-local-commands.entries.json';

describe('a stored transcript with slash commands', () => {
  it('shows each command with its output', () => {
    const lines = fromHistory(entries).items.map(it =>
      it.kind === 'command' ? commandLine(it) : it.kind === 'user' ? `user: ${it.text}` : it.kind === 'text' ? `assistant: ${it.text}` : it.kind);
    expect(lines).toEqual([
      'Ran /reload-plugins: Reloaded: 0 plugins · 0 skills · 6 agents · 0 hooks · 0 plugin MCP servers · 0 plugin LSP servers',
      'Ran /context: Context Usage',
      'Ran /reload-plugins: Reloaded: 0 plugins · 0 skills · 6 agents · 0 hooks · 0 plugin MCP servers · 0 plugin LSP servers',
      'user: hello',
      'assistant: Invalid API key · Fix external API key',
    ]);
  });
});
