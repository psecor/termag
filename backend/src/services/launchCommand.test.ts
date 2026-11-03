import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AGENT_TELEMETRY_CAPABILITY, launchCommandFor, PANE_KIND_ENV, replaySessionIdFrom, resourceEnvPrefix, TELEMETRY_REPLAY_CAPABILITY } from './launchCommand';

const RID = 'huuhcqcev124emZ9urmRjjPSNXLl';
const can = ['credentials-v1', 'telemetry-v1', TELEMETRY_REPLAY_CAPABILITY];
// Every agent command a pane types starts with it.
const K = PANE_KIND_ENV;

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
      .toBe(`${K}claude --settings "$(${K}TERMAG_PROJECT=webapp TERMAG_WORKSTREAM=main termag-credentials telemetry-launch ${RID})"`);
    expect(launchCommandFor('claude', { capabilities: can, project: 'webapp', workstream: 'feature-x' }))
      .toBe(`${K}claude --settings "$(${K}TERMAG_PROJECT=webapp TERMAG_WORKSTREAM=feature-x termag-credentials telemetry-launch -)"`);
  });

  it('types them ahead of termag-agent-otel for the wrapped agents', () => {
    const otel = [...can, AGENT_TELEMETRY_CAPABILITY];
    expect(launchCommandFor('devin', { capabilities: otel, provider: 'devin', project: 'webapp', workstream: 'main' }))
      .toBe(`${K}TERMAG_PROJECT=webapp TERMAG_WORKSTREAM=main termag-agent-otel devin -- devin`);
  });

  it('leaves a bare command bare on an older box, for a resume, and when a name is not an id', () => {
    expect(launchCommandFor('claude', { capabilities: ['credentials-v1'], project: 'webapp', workstream: 'main' })).toBe(`${K}claude`);
    expect(launchCommandFor('claude --continue', { capabilities: can, project: 'webapp', workstream: 'main' })).toBe(`${K}claude --continue`);
    expect(launchCommandFor('claude', { capabilities: can, project: 'gon falon', workstream: 'main' })).toBe(`${K}claude`);
  });
});

describe('launchCommandFor: the session\'s kind in the agent\'s environment', () => {
  const otel = [...can, AGENT_TELEMETRY_CAPABILITY];

  it('starts every pane agent\'s command with TERMAG_SESSION_KIND=interactive, on the command, not exported', () => {
    expect(K).toBe('TERMAG_SESSION_KIND=interactive ');
    for (const [cmd, provider] of [['claude', 'claude'], ['claude --continue', 'claude'], ['codex --no-alt-screen -a on-request', 'codex'],
      ['cursor-agent', 'cursor'], ['devin', 'devin'], ['pi', 'pi'], ['gemini', 'gemini']] as const) {
      for (const capabilities of [['credentials-v1'], can, otel]) {
        const typed = launchCommandFor(cmd, { capabilities, provider, project: 'webapp', workstream: 'main' });
        expect(typed.startsWith(K), `${provider} on ${capabilities.join(',')}: ${typed}`).toBe(true);
        expect(typed).not.toContain('export ');
      }
    }
  });

  it('names it to the box script that prints Claude Code\'s settings too, so an inherited kind never names a pane', () => {
    expect(launchCommandFor('claude', { replaySessionId: RID, capabilities: can })).toContain(`"$(${K}termag-credentials telemetry-launch ${RID})"`);
    const fw = [...otel, 'fireworks-v1'];
    expect(launchCommandFor('claude', { capabilities: fw, provider: 'claude', backend: 'fireworks' }))
      .toBe(`termag_settings=$(${K}termag-credentials launch-settings --backend fireworks -) && ${K}claude --settings "$termag_settings"`);
  });

  it('in a shell: the agent and its settings script see interactive over an inherited kind, and the pane\'s shell keeps what it had', () => {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-kind-'));
    fs.writeFileSync(path.join(bin, 'termag-credentials'), '#!/bin/sh\necho "settings:$TERMAG_SESSION_KIND" >&2\necho "{}"\n', { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\necho "agent:$TERMAG_SESSION_KIND"\n', { mode: 0o755 });
    const typed = launchCommandFor('claude', { replaySessionId: RID, capabilities: can, project: 'webapp', workstream: 'main' });
    const run = (inherited: Record<string, string>) => {
      const r = spawnSync('sh', ['-c', `${typed}; echo "shell:\${TERMAG_SESSION_KIND-unset}"`], { env: { PATH: `${bin}:/usr/bin:/bin`, ...inherited }, encoding: 'utf8' });
      return `${r.stderr}${r.stdout}`;
    };
    expect(run({})).toBe('settings:interactive\nagent:interactive\nshell:unset\n');
    expect(run({ TERMAG_SESSION_KIND: 'ask' })).toBe('settings:interactive\nagent:interactive\nshell:ask\n');
    fs.rmSync(bin, { recursive: true, force: true });
  });

  it('types nothing for a provider with no pane command, and no kind on a refusal', () => {
    expect(launchCommandFor('', { capabilities: otel, provider: 'claude-chat' })).toBe('');
    expect(launchCommandFor('claude', { capabilities: can, provider: 'claude', backend: 'fireworks' })).not.toContain(K);
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
      .toBe(`${K}claude --settings "$(${K}termag-credentials telemetry-launch ${RID})"`);
  });

  it('types the bare command without a replay, a bad id, an older box or another provider', () => {
    expect(launchCommandFor('claude', { capabilities: can })).toBe(`${K}claude`);
    expect(launchCommandFor('claude', { replaySessionId: null, capabilities: can })).toBe(`${K}claude`);
    expect(launchCommandFor('claude', { replaySessionId: `${RID};id`, capabilities: can })).toBe(`${K}claude`);
    expect(launchCommandFor('claude', { replaySessionId: RID, capabilities: ['credentials-v1', 'telemetry-v1'] })).toBe(`${K}claude`);
    expect(launchCommandFor('claude --continue', { replaySessionId: RID, capabilities: can })).toBe(`${K}claude --continue`);
    expect(launchCommandFor('codex --no-alt-screen -a on-request', { replaySessionId: RID, capabilities: can }))
      .toBe(`${K}codex --no-alt-screen -a on-request`);
  });
});

describe('launchCommandFor: the other agents', () => {
  const otel = [...can, AGENT_TELEMETRY_CAPABILITY];

  it('types Cursor, Devin and pi through termag-agent-otel on a box that has it, with the replay when there is one', () => {
    expect(launchCommandFor('devin', { capabilities: otel, provider: 'devin' })).toBe(`${K}termag-agent-otel devin -- devin`);
    expect(launchCommandFor('cursor-agent', { replaySessionId: RID, capabilities: otel, provider: 'cursor' }))
      .toBe(`${K}termag-agent-otel cursor --replay ${RID} -- cursor-agent`);
    expect(launchCommandFor('pi --continue', { capabilities: otel, provider: 'pi' }))
      .toBe(`${K}termag-agent-otel pi -- pi --continue`);
  });

  it('drops a bad replay id but keeps the telemetry', () => {
    expect(launchCommandFor('devin', { replaySessionId: `${RID};id`, capabilities: otel, provider: 'devin' }))
      .toBe(`${K}termag-agent-otel devin -- devin`);
  });

  it('types the bare command on an older box, for Claude and Codex, and with no provider named', () => {
    expect(launchCommandFor('devin', { replaySessionId: RID, capabilities: can, provider: 'devin' })).toBe(`${K}devin`);
    expect(launchCommandFor('devin', { capabilities: otel })).toBe(`${K}devin`);
    expect(launchCommandFor('codex --no-alt-screen -a on-request', { capabilities: otel, provider: 'codex' }))
      .toBe(`${K}codex --no-alt-screen -a on-request`);
    expect(launchCommandFor('claude --continue', { capabilities: otel, provider: 'claude' })).toBe(`${K}claude --continue`);
    expect(launchCommandFor('claude', { replaySessionId: RID, capabilities: otel, provider: 'claude' }))
      .toBe(`${K}claude --settings "$(${K}termag-credentials telemetry-launch ${RID})"`);
  });
});

describe('launchCommandFor: a workstream on a non-default model backend', () => {
  const fw = [...can, AGENT_TELEMETRY_CAPABILITY, 'fireworks-v1'];

  it('keeps Claude Code as claude, with the backend\'s settings (telemetry merged in on the box) as its one --settings', () => {
    expect(launchCommandFor('claude', { capabilities: fw, provider: 'claude', backend: 'fireworks', replaySessionId: RID, project: 'webapp', workstream: 'main' }))
      .toBe(`termag_settings=$(${K}TERMAG_PROJECT=webapp TERMAG_WORKSTREAM=main termag-credentials launch-settings --backend fireworks ${RID}) && ${K}claude --settings "$termag_settings"`);
    expect(launchCommandFor('claude --continue', { capabilities: fw, provider: 'claude', backend: 'fireworks' }))
      .toBe(`termag_settings=$(${K}termag-credentials launch-settings --backend fireworks -) && ${K}claude --settings "$termag_settings" --continue`);
    expect(launchCommandFor('claude "$(cat /tmp/brief)"', { capabilities: fw, provider: 'claude', backend: 'fireworks' }))
      .toBe(`termag_settings=$(${K}termag-credentials launch-settings --backend fireworks -) && ${K}claude --settings "$termag_settings" "$(cat /tmp/brief)"`);
  });

  it("starts pi through the backend's launcher, still wrapped for telemetry", () => {
    expect(launchCommandFor('pi --continue', { capabilities: fw, provider: 'pi', backend: 'fireworks', project: 'p', workstream: 'w' }))
      .toBe(`${K}TERMAG_PROJECT=p TERMAG_WORKSTREAM=w termag-agent-otel pi -- termag-pi-fireworks --continue`);
  });

  it('says so, instead of starting the default backend, on a box that cannot run it', () => {
    const got = launchCommandFor('claude', { capabilities: can, provider: 'claude', backend: 'fireworks' });
    expect(got).toMatch(/^echo 'termag: this box cannot run Claude on fireworks yet; update it/);
  });

  it('leaves the default backend, an unknown backend and a command that is not the harness alone', () => {
    expect(launchCommandFor('claude', { capabilities: fw, provider: 'claude', backend: null })).toBe(`${K}claude`);
    expect(launchCommandFor('claude', { capabilities: fw, provider: 'claude', backend: 'bedrock' })).toBe(`${K}claude`);
    expect(launchCommandFor('devin', { capabilities: ['credentials-v1'], provider: 'devin', backend: 'fireworks' })).toBe(`${K}devin`);
    expect(launchCommandFor('something-else', { capabilities: fw, provider: 'claude', backend: 'fireworks' })).toBe(`${K}something-else`);
  });
});

describe('launchCommandFor: the workstream\'s model', () => {
  const fw = [...can, AGENT_TELEMETRY_CAPABILITY, 'fireworks-v1'];
  const KIMI = 'accounts/fireworks/models/kimi-k3';

  it('puts --model right after the harness, on every launch form', () => {
    expect(launchCommandFor('claude', { capabilities: ['credentials-v1'], provider: 'claude', model: 'sonnet' })).toBe(`${K}claude --model sonnet`);
    expect(launchCommandFor('claude --continue', { capabilities: can, provider: 'claude', model: 'haiku' })).toBe(`${K}claude --model haiku --continue`);
    expect(launchCommandFor('claude', { capabilities: can, provider: 'claude', model: 'opus', project: 'p', workstream: 'w' }))
      .toBe(`${K}claude --settings "$(${K}TERMAG_PROJECT=p TERMAG_WORKSTREAM=w termag-credentials telemetry-launch -)" --model opus`);
  });

  it('on a backend: to the box script with the fast model and window, which keeps no model list', () => {
    const DS = 'accounts/fireworks/models/deepseek-v4p1-flash';
    expect(launchCommandFor('claude --continue', { capabilities: fw, provider: 'claude', backend: 'fireworks', model: KIMI, fastModel: DS, context: 1048576 }))
      .toBe(`termag_settings=$(${K}termag-credentials launch-settings --backend fireworks --model ${KIMI} --fast ${DS} --context 1048576 -) && ${K}claude --settings "$termag_settings" --continue`);
    expect(launchCommandFor('pi', { capabilities: fw, provider: 'pi', backend: 'fireworks', model: KIMI, fastModel: DS, context: 512000 }))
      .toBe(`${K}termag-agent-otel pi -- termag-pi-fireworks --model ${KIMI} --context 512000`);
  });

  it("adds the flag's model list for Claude Code's /model menu on a box with fireworks-menu-v1 only", () => {
    const DS = 'accounts/fireworks/models/deepseek-v4p1-flash';
    const models = Buffer.from(JSON.stringify([{ id: KIMI, label: 'Kimi K3' }, { id: DS, label: 'DeepSeek V4.1 Flash' }])).toString('base64');
    const on = { provider: 'claude', backend: 'fireworks', model: KIMI, fastModel: DS, models };
    expect(launchCommandFor('claude', { capabilities: [...fw, 'fireworks-menu-v1'], ...on }))
      .toBe(`termag_settings=$(${K}termag-credentials launch-settings --backend fireworks --model ${KIMI} --fast ${DS} --models ${models} -) && ${K}claude --settings "$termag_settings"`);
    // An older box script would take --models for the replay id.
    expect(launchCommandFor('claude', { capabilities: fw, ...on }))
      .toBe(`termag_settings=$(${K}termag-credentials launch-settings --backend fireworks --model ${KIMI} --fast ${DS} -) && ${K}claude --settings "$termag_settings"`);
    expect(launchCommandFor('claude', { capabilities: [...fw, 'fireworks-menu-v1'], ...on, models: "x' ; rm" })).not.toContain('--models');
    expect(launchCommandFor('pi', { capabilities: [...fw, 'fireworks-menu-v1'], ...on, provider: 'pi' })).not.toContain('--models');
  });

  it("gives pi the flag's model list for its /model on a box with fireworks-pi-menu-v1 only", () => {
    const models = Buffer.from(JSON.stringify([{ id: KIMI, label: 'Kimi K3', context: 1048576 }])).toString('base64');
    const on = { provider: 'pi', backend: 'fireworks', model: KIMI, context: 1048576, models };
    expect(launchCommandFor('pi --continue', { capabilities: [...fw, 'fireworks-pi-menu-v1'], ...on }))
      .toBe(`${K}termag-agent-otel pi -- termag-pi-fireworks --model ${KIMI} --context 1048576 --models ${models} --continue`);
    // An older launcher would pass --models on to pi, and an older pi-model refuses it.
    expect(launchCommandFor('pi', { capabilities: [...fw, 'fireworks-menu-v1'], ...on })).not.toContain('--models');
    expect(launchCommandFor('pi', { capabilities: [...fw, 'fireworks-pi-menu-v1'], ...on, models: "x' ; rm" })).not.toContain('--models');
    // Claude Code's capability is its own.
    expect(launchCommandFor('claude', { capabilities: [...fw, 'fireworks-pi-menu-v1'], ...on, provider: 'claude' })).not.toContain('--models');
  });

  it('drops a model that could not be typed safely', () => {
    expect(launchCommandFor('claude', { capabilities: ['credentials-v1'], provider: 'claude', model: 'opus; rm -rf ~' })).toBe(`${K}claude`);
  });
});

describe('launchCommandFor: a Claude pane in a space gets no skills from it (docs/space-memory.md)', () => {
  it('types plain claude on a box with space-memory-v1: space memory reaches a pane through its hooks only', () => {
    const caps = ['space-memory-v1', TELEMETRY_REPLAY_CAPABILITY];
    for (const cmd of ['claude', 'claude --continue', 'claude "$(cat /tmp/p)"']) {
      const typed = launchCommandFor(cmd, { capabilities: caps, provider: 'claude', project: 'web', workstream: 'main' });
      expect(typed).not.toMatch(/pane-claude|plugin-dir|termag_claude/);
      expect(typed).toBe(launchCommandFor(cmd, { capabilities: [TELEMETRY_REPLAY_CAPABILITY], provider: 'claude', project: 'web', workstream: 'main' }));
    }
  });
});
