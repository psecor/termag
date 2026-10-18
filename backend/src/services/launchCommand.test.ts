import { describe, expect, it } from 'vitest';
import { AGENT_TELEMETRY_CAPABILITY, launchCommandFor, replaySessionIdFrom, TELEMETRY_REPLAY_CAPABILITY } from './launchCommand';

const RID = 'huuhcqcev124emZ9urmRjjPSNXLl';
const can = ['credentials-v1', 'telemetry-v1', TELEMETRY_REPLAY_CAPABILITY];

describe('replaySessionIdFrom', () => {
  it('accepts a replay secure id and nothing else', () => {
    expect(replaySessionIdFrom(RID)).toBe(RID);
    expect(replaySessionIdFrom('a'.repeat(20))).toBe('a'.repeat(20));
    expect(replaySessionIdFrom('a'.repeat(64))).toBe('a'.repeat(64));
    for (const bad of [undefined, null, 42, '', 'short', 'a'.repeat(65), `${RID};id`, `${RID} ${RID}`, `${RID}\n`, `$(${RID})`]) {
      expect(replaySessionIdFrom(bad)).toBeNull();
    }
  });
});

describe('launchCommandFor', () => {
  it('types the replay settings for a Claude launch from a browser onto a box that can print them', () => {
    expect(launchCommandFor('claude', { replaySessionId: RID, capabilities: can }))
      .toBe(`claude --settings "$(termag-credentials telemetry-launch ${RID})"`);
  });

  it('types the bare command without a replay, a bad id, an older box or another provider', () => {
    expect(launchCommandFor('claude', { capabilities: can })).toBe('claude');
    expect(launchCommandFor('claude', { replaySessionId: null, capabilities: can })).toBe('claude');
    expect(launchCommandFor('claude', { replaySessionId: `${RID};id`, capabilities: can })).toBe('claude');
    expect(launchCommandFor('claude', { replaySessionId: RID, capabilities: ['credentials-v1', 'telemetry-v1'] })).toBe('claude');
    expect(launchCommandFor('claude --continue', { replaySessionId: RID, capabilities: can })).toBe('claude --continue');
    expect(launchCommandFor('codex --no-alt-screen -a on-request', { replaySessionId: RID, capabilities: can }))
      .toBe('codex --no-alt-screen -a on-request');
  });
});

describe('launchCommandFor: the other agents', () => {
  const otel = [...can, AGENT_TELEMETRY_CAPABILITY];

  it('types Cursor, Devin and pi through termag-agent-otel on a box that has it, with the replay when there is one', () => {
    expect(launchCommandFor('devin', { capabilities: otel, provider: 'devin' })).toBe('termag-agent-otel devin -- devin');
    expect(launchCommandFor('cursor-agent', { replaySessionId: RID, capabilities: otel, provider: 'cursor' }))
      .toBe(`termag-agent-otel cursor --replay ${RID} -- cursor-agent`);
    expect(launchCommandFor('pi --continue', { capabilities: otel, provider: 'pi' }))
      .toBe('termag-agent-otel pi -- pi --continue');
  });

  it('drops a bad replay id but keeps the telemetry', () => {
    expect(launchCommandFor('devin', { replaySessionId: `${RID};id`, capabilities: otel, provider: 'devin' }))
      .toBe('termag-agent-otel devin -- devin');
  });

  it('types the bare command on an older box, for Claude and Codex, and with no provider named', () => {
    expect(launchCommandFor('devin', { replaySessionId: RID, capabilities: can, provider: 'devin' })).toBe('devin');
    expect(launchCommandFor('devin', { capabilities: otel })).toBe('devin');
    expect(launchCommandFor('codex --no-alt-screen -a on-request', { capabilities: otel, provider: 'codex' }))
      .toBe('codex --no-alt-screen -a on-request');
    expect(launchCommandFor('claude --continue', { capabilities: otel, provider: 'claude' })).toBe('claude --continue');
    expect(launchCommandFor('claude', { replaySessionId: RID, capabilities: otel, provider: 'claude' }))
      .toBe(`claude --settings "$(termag-credentials telemetry-launch ${RID})"`);
  });
});
