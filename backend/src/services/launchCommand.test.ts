import { describe, expect, it } from 'vitest';
import { AGENT_TELEMETRY_CAPABILITY, launchCommandFor, replaySessionIdFrom, resourceEnvPrefix, TELEMETRY_REPLAY_CAPABILITY } from './launchCommand';

const RID = 'huuhcqcev124emZ9urmRjjPSNXLl';
const can = ['credentials-v1', 'telemetry-v1', TELEMETRY_REPLAY_CAPABILITY];

describe('resourceEnvPrefix', () => {
  it('names the project and workstream for the box scripts, both or neither, ids only', () => {
    expect(resourceEnvPrefix('webapp', 'main')).toBe('TERMAG_PROJECT=webapp TERMAG_WORKSTREAM=main ');
    expect(resourceEnvPrefix('webapp', null)).toBe('');
    expect(resourceEnvPrefix(undefined, 'main')).toBe('');
    expect(resourceEnvPrefix('gon falon', 'main')).toBe('');
    expect(resourceEnvPrefix('webapp', 'ws;rm -rf')).toBe('');
    expect(resourceEnvPrefix('a'.repeat(65), 'main')).toBe('');
  });
});

describe('launchCommandFor: the project and workstream on the resource', () => {
  it('types them ahead of the Claude settings, with or without a replay', () => {
    expect(launchCommandFor('claude', { replaySessionId: RID, capabilities: can, project: 'webapp', workstream: 'main' }))
      .toBe(`claude --settings "$(TERMAG_PROJECT=webapp TERMAG_WORKSTREAM=main termag-credentials telemetry-launch ${RID})"`);
    expect(launchCommandFor('claude', { capabilities: can, project: 'webapp', workstream: 'feature-x' }))
      .toBe('claude --settings "$(TERMAG_PROJECT=webapp TERMAG_WORKSTREAM=feature-x termag-credentials telemetry-launch -)"');
  });

  it('types them ahead of termag-agent-otel for the wrapped agents', () => {
    const otel = [...can, AGENT_TELEMETRY_CAPABILITY];
    expect(launchCommandFor('devin', { capabilities: otel, provider: 'devin', project: 'webapp', workstream: 'main' }))
      .toBe('TERMAG_PROJECT=webapp TERMAG_WORKSTREAM=main termag-agent-otel devin -- devin');
  });

  it('leaves a bare command bare on an older box, for a resume, and when a name is not an id', () => {
    expect(launchCommandFor('claude', { capabilities: ['credentials-v1'], project: 'webapp', workstream: 'main' })).toBe('claude');
    expect(launchCommandFor('claude --continue', { capabilities: can, project: 'webapp', workstream: 'main' })).toBe('claude --continue');
    expect(launchCommandFor('claude', { capabilities: can, project: 'gon falon', workstream: 'main' })).toBe('claude');
  });
});

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

describe('launchCommandFor: a workstream on a non-default model backend', () => {
  const fw = [...can, AGENT_TELEMETRY_CAPABILITY, 'fireworks-v1'];

  it('keeps Claude Code as claude, with the backend\'s settings (telemetry merged in on the box) as its one --settings', () => {
    expect(launchCommandFor('claude', { capabilities: fw, provider: 'claude', backend: 'fireworks', replaySessionId: RID, project: 'webapp', workstream: 'main' }))
      .toBe(`termag_settings=$(TERMAG_PROJECT=webapp TERMAG_WORKSTREAM=main termag-credentials launch-settings --backend fireworks ${RID}) && claude --settings "$termag_settings"`);
    expect(launchCommandFor('claude --continue', { capabilities: fw, provider: 'claude', backend: 'fireworks' }))
      .toBe('termag_settings=$(termag-credentials launch-settings --backend fireworks -) && claude --settings "$termag_settings" --continue');
    expect(launchCommandFor('claude "$(cat /tmp/brief)"', { capabilities: fw, provider: 'claude', backend: 'fireworks' }))
      .toBe('termag_settings=$(termag-credentials launch-settings --backend fireworks -) && claude --settings "$termag_settings" "$(cat /tmp/brief)"');
  });

  it("starts pi through the backend's launcher, still wrapped for telemetry", () => {
    expect(launchCommandFor('pi --continue', { capabilities: fw, provider: 'pi', backend: 'fireworks', project: 'p', workstream: 'w' }))
      .toBe('TERMAG_PROJECT=p TERMAG_WORKSTREAM=w termag-agent-otel pi -- termag-pi-fireworks --continue');
  });

  it('says so, instead of starting the default backend, on a box that cannot run it', () => {
    const got = launchCommandFor('claude', { capabilities: can, provider: 'claude', backend: 'fireworks' });
    expect(got).toMatch(/^echo 'termag: this box cannot run Claude on fireworks yet; update it/);
  });

  it('leaves the default backend, an unknown backend and a command that is not the harness alone', () => {
    expect(launchCommandFor('claude', { capabilities: fw, provider: 'claude', backend: null })).toBe('claude');
    expect(launchCommandFor('claude', { capabilities: fw, provider: 'claude', backend: 'bedrock' })).toBe('claude');
    expect(launchCommandFor('devin', { capabilities: ['credentials-v1'], provider: 'devin', backend: 'fireworks' })).toBe('devin');
    expect(launchCommandFor('something-else', { capabilities: fw, provider: 'claude', backend: 'fireworks' })).toBe('something-else');
  });
});

describe('launchCommandFor: the workstream\'s model', () => {
  const fw = [...can, AGENT_TELEMETRY_CAPABILITY, 'fireworks-v1'];
  const KIMI = 'accounts/fireworks/models/kimi-k3';

  it('puts --model right after the harness, on every launch form', () => {
    expect(launchCommandFor('claude', { capabilities: ['credentials-v1'], provider: 'claude', model: 'sonnet' })).toBe('claude --model sonnet');
    expect(launchCommandFor('claude --continue', { capabilities: can, provider: 'claude', model: 'haiku' })).toBe('claude --model haiku --continue');
    expect(launchCommandFor('claude', { capabilities: can, provider: 'claude', model: 'opus', project: 'p', workstream: 'w' }))
      .toBe('claude --settings "$(TERMAG_PROJECT=p TERMAG_WORKSTREAM=w termag-credentials telemetry-launch -)" --model opus');
  });

  it('on a backend: to the box script with the fast model and window, which keeps no model list', () => {
    const DS = 'accounts/fireworks/models/deepseek-v4p1-flash';
    expect(launchCommandFor('claude --continue', { capabilities: fw, provider: 'claude', backend: 'fireworks', model: KIMI, fastModel: DS, context: 1048576 }))
      .toBe(`termag_settings=$(termag-credentials launch-settings --backend fireworks --model ${KIMI} --fast ${DS} --context 1048576 -) && claude --settings "$termag_settings" --continue`);
    expect(launchCommandFor('pi', { capabilities: fw, provider: 'pi', backend: 'fireworks', model: KIMI, fastModel: DS, context: 512000 }))
      .toBe(`termag-agent-otel pi -- termag-pi-fireworks --model ${KIMI} --context 512000`);
  });

  it('drops a model that could not be typed safely', () => {
    expect(launchCommandFor('claude', { capabilities: ['credentials-v1'], provider: 'claude', model: 'opus; rm -rf ~' })).toBe('claude');
  });
});
