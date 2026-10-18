import { describe, expect, it } from 'vitest';
import {
  CLEAR_SETTLE_MS,
  COMPACT_MAX_WAIT_MS,
  READIN_CLAIM_STALE_MS,
  REQUEST_TIMEOUT_MS,
  RESET_TIMEOUT_MS,
  RESTART_RETRY_MS,
  WRITE_TIMEOUT_MS,
  buildHandoffPrompt,
  canHandOffFrom,
  canRestartInto,
  handoffLaunchCommand,
  handoffPromptPath,
  handoffStep,
  parseHandoffRequest,
  parseWritten,
  planMode,
  readInLine,
  writeRequestLine,
  type StepInput,
} from './agentHandoff';

describe('parseHandoffRequest', () => {
  it('defaults to clear and keeps only what was given', () => {
    expect(parseHandoffRequest({})).toEqual({ ok: true, value: { mode: 'clear' } });
    expect(parseHandoffRequest({ mode: 'restart', provider: 'cursor', note: '  look at the flaky test ', session: 'me-proj-agent' }))
      .toEqual({ ok: true, value: { mode: 'restart', provider: 'cursor', note: 'look at the flaky test', session: 'me-proj-agent' } });
  });

  it('refuses an unknown mode, an oversized body and a session that is not a tmux name', () => {
    expect(parseHandoffRequest({ mode: 'exit' }).ok).toBe(false);
    expect(parseHandoffRequest({ body: 'x'.repeat(32_001) }).ok).toBe(false);
    expect(parseHandoffRequest({ session: 'a b; rm' }).ok).toBe(false);
  });
});

describe('parseWritten', () => {
  it('needs the session and a body', () => {
    expect(parseWritten({ session: 'me-proj-agent', body: '## Goal\nx' })).toEqual({ ok: true, value: { session: 'me-proj-agent', body: '## Goal\nx' } });
    expect(parseWritten({ session: 'me-proj-agent' }).ok).toBe(false);
    expect(parseWritten({ body: 'x' }).ok).toBe(false);
  });
});

describe('providers', () => {
  it('hands off pane agents termag can start on a file, never Codex or the chat runner', () => {
    expect(canHandOffFrom('claude')).toBe(true);
    expect(canHandOffFrom('pi')).toBe(true);
    // No metaterm tools reach Cursor or Devin, so they cannot write a handoff…
    expect(canHandOffFrom('devin')).toBe(false);
    expect(canHandOffFrom('cursor')).toBe(false);
    expect(canHandOffFrom('codex')).toBe(false);
    expect(canHandOffFrom('claude-chat')).toBe(false);
    expect(canRestartInto('cursor')).toBe(true);
    expect(canRestartInto('codex')).toBe(false);
  });

  it('keeps clear and compact for an agent that has the command, and restarts otherwise', () => {
    expect(planMode('clear', 'claude')).toEqual({ mode: 'clear' });
    expect(planMode('compact', 'claude', 'claude')).toEqual({ mode: 'compact' });
    expect(planMode('restart', 'claude')).toEqual({ mode: 'restart' });
    // pi's own /new and /compact.
    expect(planMode('clear', 'pi')).toEqual({ mode: 'clear' });
    expect(planMode('compact', 'pi')).toEqual({ mode: 'compact' });
    expect(planMode('clear', 'cursor')).toMatchObject({ mode: 'restart', fallback: expect.stringMatching(/Cursor has no clear command/) });
    expect(planMode('clear', 'claude', 'devin')).toMatchObject({ mode: 'restart', fallback: expect.stringMatching(/switching to Devin restarts/) });
  });
});

describe('files and lines', () => {
  it('puts the prompt under ~/.termag/handoffs and names it through $HOME in the launch', () => {
    expect(handoffPromptPath('/home/me/', 'ck1')).toBe('/home/me/.termag/handoffs/ck1.md');
    expect(handoffLaunchCommand('claude', 'ck1')).toBe('claude "$(cat "$HOME/.termag/handoffs/ck1.md")"');
    expect(handoffLaunchCommand('devin', 'ck1')).toBe('devin --prompt-file "$HOME/.termag/handoffs/ck1.md"');
    expect(() => handoffPromptPath('/home/me', '../x')).toThrow();
    expect(() => handoffLaunchCommand('codex', 'ck1')).toThrow();
  });

  it('types fixed lines that carry only the id', () => {
    expect(writeRequestLine('ck1')).toMatch(/termag-handoff skill.*handoff_written.*handoffId ck1/);
    expect(readInLine('ck1')).toMatch(/Read ~\/\.termag\/handoffs\/ck1\.md and continue/);
  });

  it('builds the prompt from a fixed header, the note and the handoff', () => {
    const text = buildHandoffPrompt({
      id: 'ck1', projectName: 'proj', workstream: 'feat', fromProvider: 'claude', toProvider: 'cursor',
      createdAt: new Date('2026-10-18T00:00:00Z'), note: 'focus on tests', body: '## Goal\nship it',
    });
    expect(text).toMatch(/^You are continuing work in project proj, workstream feat\. The previous agent in this pane \(Claude\)/);
    expect(text).toMatch(/switched it to Cursor and reset/);
    expect(text).toContain('--- note from whoever asked for the handoff ---\nfocus on tests');
    expect(text).toContain('--- handoff ---\n## Goal\nship it');
  });
});

describe('handoffStep', () => {
  const now = Date.parse('2026-10-18T12:00:00Z');
  const base: StepInput = {
    state: 'requested', mode: 'clear', initiator: 'person', paneStatus: 'idle', connected: true, humanLastTyped: null,
    createdAt: new Date(now - 1000), writeRequestedAt: null, writtenAt: null, resetAt: null, launchedAt: null,
    contextTokensBefore: 200_000, contextTokensNow: 200_000, now,
  };
  const step = (o: Partial<StepInput>) => handoffStep({ ...base, ...o });

  it('asks for the handoff only in an idle pane on a connected box', () => {
    expect(step({})).toEqual({ kind: 'request-write' });
    expect(step({ paneStatus: 'waiting' })).toEqual({ kind: 'wait' });
    expect(step({ paneStatus: 'working' })).toEqual({ kind: 'wait' });
    expect(step({ connected: false })).toEqual({ kind: 'wait' });
    expect(step({ createdAt: new Date(now - REQUEST_TIMEOUT_MS - 1) }).kind).toBe('abort');
  });

  it('holds an agent-started handoff while the owner is typing; a person-started one is the person asking', () => {
    expect(step({ initiator: 'agent', humanLastTyped: now - 30_000 })).toEqual({ kind: 'wait' });
    expect(step({ initiator: 'agent', humanLastTyped: now - 3 * 60_000 })).toEqual({ kind: 'request-write' });
    expect(step({ initiator: 'person', humanLastTyped: now - 1000 })).toEqual({ kind: 'request-write' });
  });

  it('aborts a handoff that was never written, without touching the pane', () => {
    expect(step({ state: 'writing', writeRequestedAt: new Date(now - 60_000) })).toEqual({ kind: 'wait' });
    expect(step({ state: 'writing', writeRequestedAt: new Date(now - WRITE_TIMEOUT_MS - 1) }).kind).toBe('abort');
  });

  it('resets once the agent that wrote it is back at its prompt', () => {
    expect(step({ state: 'written', paneStatus: 'working' })).toEqual({ kind: 'wait' });
    expect(step({ state: 'written' })).toEqual({ kind: 'reset' });
    // clear and compact type into the pane, so they need a live prompt.
    expect(step({ state: 'written', paneStatus: 'not_running' })).toEqual({ kind: 'wait' });
  });

  it('restarts a pane that reads not_running: it kills the pane, so needs no prompt', () => {
    const written = { state: 'written' as const, mode: 'restart' as const };
    expect(step({ ...written, paneStatus: 'not_running' })).toEqual({ kind: 'reset' });
    expect(step({ ...written, paneStatus: 'waiting' })).toEqual({ kind: 'wait' });
    expect(step({ ...written, paneStatus: 'working' })).toEqual({ kind: 'wait' });
    expect(step({ ...written, paneStatus: 'not_running', connected: false })).toEqual({ kind: 'wait' });
  });

  it('reads in after /clear has settled', () => {
    const resetting = { state: 'resetting' as const, mode: 'clear' as const };
    expect(step({ ...resetting, resetAt: new Date(now - 1000) })).toEqual({ kind: 'wait' });
    expect(step({ ...resetting, resetAt: new Date(now - CLEAR_SETTLE_MS) })).toEqual({ kind: 'read-in' });
    expect(step({ ...resetting, resetAt: new Date(now - CLEAR_SETTLE_MS), paneStatus: 'working' })).toEqual({ kind: 'wait' });
    // Another tick holds the read-in claim…
    expect(step({ ...resetting, resetAt: new Date(now - CLEAR_SETTLE_MS), launchedAt: new Date(now) })).toEqual({ kind: 'wait' });
    // …unless it went stale: a dead leader's claim is taken again.
    expect(step({ ...resetting, resetAt: new Date(now - 60_000), launchedAt: new Date(now - READIN_CLAIM_STALE_MS) })).toEqual({ kind: 'read-in' });
  });

  it('reads in after /compact once the context reading drops, or after the longest wait', () => {
    const resetting = { state: 'resetting' as const, mode: 'compact' as const, resetAt: new Date(now - 10_000) };
    expect(step(resetting)).toEqual({ kind: 'wait' });
    expect(step({ ...resetting, contextTokensNow: 40_000 })).toEqual({ kind: 'read-in' });
    expect(step({ ...resetting, resetAt: new Date(now - COMPACT_MAX_WAIT_MS) })).toEqual({ kind: 'read-in' });
  });

  it('retries a restart whose launch did not type, and gives up after a while', () => {
    const resetting = { state: 'resetting' as const, mode: 'restart' as const, paneStatus: 'not_running' };
    expect(step({ ...resetting, resetAt: new Date(now - 1000) })).toEqual({ kind: 'wait' });
    expect(step({ ...resetting, resetAt: new Date(now - RESTART_RETRY_MS) })).toEqual({ kind: 'relaunch' });
    expect(step({ ...resetting, resetAt: new Date(now - RESET_TIMEOUT_MS - 1) }).kind).toBe('fail');
    expect(step({ ...resetting, resetAt: new Date(now - RESTART_RETRY_MS), launchedAt: new Date(now) })).toEqual({ kind: 'wait' });
    // A row stuck with launchedAt set still times out, or it would hold the pane for good.
    expect(step({ ...resetting, resetAt: new Date(now - RESET_TIMEOUT_MS - 1), launchedAt: new Date(now) }).kind).toBe('fail');
  });
});
