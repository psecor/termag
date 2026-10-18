import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { RUNNER_UNIT, runnerUnitArgv, runnerUnitControlFromEnv, runnerUnitOnLease, type RunnerUnitVerb } from './claudeRunnerUnit';

function fake(opts: { enabled?: boolean; fail?: RunnerUnitVerb } = {}) {
  const calls: string[] = [];
  const logs: string[] = [];
  const unit = runnerUnitOnLease({
    systemctl: async verb => {
      calls.push(verb);
      if (opts.fail === verb) throw new Error('sudo: a password is required');
    },
    isEnabled: async () => { calls.push('is-enabled'); return opts.enabled ?? true; },
    log: msg => logs.push(msg),
  });
  return { unit, calls, logs };
}

describe('runnerUnitOnLease', () => {
  it('stops the runner on drain', async () => {
    const { unit, calls, logs } = fake();
    await unit.drain();
    expect(calls).toEqual(['stop']);
    expect(logs[0]).toContain('stopped');
  });

  it('starts an enabled runner on serve, including after a drain (failover)', async () => {
    const { unit, calls } = fake();
    await unit.drain();
    await unit.serve();
    expect(calls).toEqual(['stop', 'is-enabled', 'start']);
  });

  it('leaves a disabled runner off on serve', async () => {
    const { unit, calls, logs } = fake({ enabled: false });
    await unit.serve();
    expect(calls).toEqual(['is-enabled']);
    expect(logs).toEqual([]);
  });

  it('logs a failed stop instead of throwing', async () => {
    const { unit, logs } = fake({ fail: 'stop' });
    await expect(unit.drain()).resolves.toBeUndefined();
    expect(logs[0]).toMatch(/could not stop .*a password is required.*503/);
  });

  it('logs a failed start instead of throwing', async () => {
    const { unit, logs } = fake({ fail: 'start' });
    await expect(unit.serve()).resolves.toBeUndefined();
    expect(logs[0]).toMatch(/could not start/);
  });

  it('runs calls one at a time, in order', async () => {
    const order: string[] = [];
    let release!: () => void;
    const unit = runnerUnitOnLease({
      systemctl: verb => {
        order.push(`${verb}:begin`);
        if (verb === 'stop') return new Promise<void>(r => { release = () => { order.push('stop:end'); r(); }; });
        order.push(`${verb}:end`);
        return Promise.resolve();
      },
      isEnabled: async () => true,
      log: () => {},
    });
    const drained = unit.drain();
    const served = unit.serve();
    await new Promise(r => setTimeout(r, 0));
    expect(order).toEqual(['stop:begin']);
    release();
    await Promise.all([drained, served]);
    expect(order).toEqual(['stop:begin', 'stop:end', 'start:begin', 'start:end']);
  });
});

describe('runnerUnitControlFromEnv', () => {
  it('is on only with the lease on and the baked unit present', () => {
    expect(runnerUnitControlFromEnv(true, true)).not.toBeNull();
    expect(runnerUnitControlFromEnv(false, true)).toBeNull();
    expect(runnerUnitControlFromEnv(true, false)).toBeNull();
  });
});

describe('the sudoers rule', () => {
  const rule = readFileSync(join(__dirname, '../../../deploy/claude-runner-orchestrator.sudoers'), 'utf8')
    .split('\n').filter(l => l.trim() && !l.trim().startsWith('#'));

  it('is one line for the termag user, without wildcards', () => {
    expect(rule).toHaveLength(1);
    expect(rule[0]).toMatch(/^termag ALL=\(root\) NOPASSWD: /);
    expect(rule[0]).not.toMatch(/[*?]|ALL$/);
  });

  it('allows exactly the command lines the backend runs', () => {
    const allowed = rule[0].replace(/^termag ALL=\(root\) NOPASSWD: /, '').split(/,\s*/);
    const run = (['stop', 'start'] as const).map(v => runnerUnitArgv(v).slice(1).join(' '));
    expect(allowed.sort()).toEqual(run.sort());
    expect(runnerUnitArgv('stop')).toEqual(['-n', '/usr/bin/systemctl', 'stop', RUNNER_UNIT]);
  });
});
