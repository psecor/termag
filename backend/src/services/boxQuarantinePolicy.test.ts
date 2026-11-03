import { describe, expect, it } from 'vitest';
import {
  LAUNCH_FOLLOW_UP_SETTLE_MS,
  NO_INSTANCE_YET,
  QUARANTINE_STEPS,
  SNAPSHOT_IN_PROGRESS,
  deniesEverythingPolicy,
  ec2Text,
  mergeStepResults,
  needsStop,
  parseQuarantineBody,
  parseStepResults,
  quarantineInstanceTags,
  quarantineRefusal,
  quarantineSnapshotTags,
  quarantineTerminateRefusal,
  needsContainmentRun,
  snapshotTargets,
  stepsToRun,
  stopUnsettled,
  type QuarantineStepResult,
} from './boxQuarantinePolicy';

const at = '2026-10-23T18:00:00.000Z';
const result = (step: QuarantineStepResult['step'], outcome: QuarantineStepResult['outcome']): QuarantineStepResult =>
  ({ step, outcome, detail: '', at });

describe('parseQuarantineBody', () => {
  it('needs confirm: true and a reason', () => {
    expect(parseQuarantineBody({ reason: 'LiteLLM 1.107.0 on the box' })).toEqual({ error: 'confirm: true is required' });
    expect(parseQuarantineBody({ confirm: 'yes', reason: 'x' })).toEqual({ error: 'confirm: true is required' });
    expect(parseQuarantineBody({ confirm: true, reason: '   ' })).toEqual({ error: 'reason is required' });
    expect(parseQuarantineBody(null)).toEqual({ error: 'body must be an object' });
    expect(parseQuarantineBody({ confirm: true, reason: 'x'.repeat(501) })).toHaveProperty('error');
  });

  it('trims the reason', () => {
    expect(parseQuarantineBody({ confirm: true, reason: '  scanner: adv-2026-188  ' })).toEqual({ reason: 'scanner: adv-2026-188' });
    // The limit applies to what is kept, not to trailing whitespace.
    expect(parseQuarantineBody({ confirm: true, reason: `${'x'.repeat(500)}   ` })).toEqual({ reason: 'x'.repeat(500) });
  });
});

describe('quarantineRefusal', () => {
  const box = { kind: 'ec2', status: 'ready', ec2InstanceId: 'i-1' };

  it('takes any box that still exists, whatever its state', () => {
    for (const status of ['ready', 'stopped', 'hibernated', 'starting', 'failed', 'warm', 'provisioning']) {
      expect(quarantineRefusal({ ...box, status })).toBeNull();
    }
    expect(quarantineRefusal({ ...box, kind: 'external', ec2InstanceId: null })).toBeNull();
  });

  it('accepts a box already quarantined, to retry what did not finish', () => {
    expect(quarantineRefusal({ ...box, status: 'quarantined' })).toBeNull();
  });

  it('refuses a missing or terminated box', () => {
    expect(quarantineRefusal(null)?.status).toBe(404);
    expect(quarantineRefusal({ ...box, status: 'terminated' })?.status).toBe(409);
  });
});

describe('quarantineTerminateRefusal', () => {
  const box = { kind: 'ec2', status: 'quarantined', ec2InstanceId: 'i-1' };

  it('only terminates a quarantined box', () => {
    expect(quarantineTerminateRefusal(box)).toBeNull();
    expect(quarantineTerminateRefusal({ ...box, status: 'ready' })?.status).toBe(409);
    expect(quarantineTerminateRefusal({ ...box, status: 'terminated' })?.status).toBe(409);
    expect(quarantineTerminateRefusal(null)?.status).toBe(404);
  });
});

describe('QUARANTINE_STEPS', () => {
  it('stops the box before it snapshots it: only the stop ends connections already open, and the disks are copied quiet', () => {
    expect(QUARANTINE_STEPS.indexOf('network')).toBeLessThan(QUARANTINE_STEPS.indexOf('stop'));
    expect(QUARANTINE_STEPS.indexOf('stop')).toBeLessThan(QUARANTINE_STEPS.indexOf('snapshot'));
  });
});

describe('stepsToRun', () => {
  it('runs every step the first time', () => {
    expect(stepsToRun(null)).toEqual([...QUARANTINE_STEPS]);
  });

  it('re-runs what failed or was skipped, never what is done', () => {
    const previous = [result('tokens', 'done'), result('tag', 'failed'), result('iam', 'done'), result('network', 'skipped'),
      result('snapshot', 'done'), result('stop', 'failed')];
    expect(stepsToRun(previous)).toEqual(['tag', 'network', 'stop']);
  });
});

describe('mergeStepResults', () => {
  it('keeps one entry per step, the newest, in step order', () => {
    const merged = mergeStepResults(
      [result('stop', 'failed'), result('tokens', 'done'), result('tag', 'failed')],
      [result('tag', 'done'), result('stop', 'done')],
    );
    expect(merged.map(r => `${r.step}=${r.outcome}`)).toEqual(['tokens=done', 'tag=done', 'stop=done']);
  });
});

describe('parseStepResults', () => {
  it('reads back what was written and drops anything malformed', () => {
    expect(parseStepResults(null)).toBeNull();
    expect(parseStepResults({ step: 'tag' })).toBeNull();
    expect(parseStepResults([result('tag', 'done'), { step: 'nope', outcome: 'done' }, { step: 'stop', outcome: 'maybe' }, 7]))
      .toEqual([result('tag', 'done')]);
  });
});

describe('deniesEverythingPolicy', () => {
  it('is one explicit Deny of every action on every resource', () => {
    expect(JSON.parse(deniesEverythingPolicy())).toEqual({
      Version: '2012-10-17',
      Statement: [{ Sid: 'TermagQuarantineDenyAll', Effect: 'Deny', Action: '*', Resource: '*' }],
    });
  });
});

describe('EC2 text', () => {
  it('is printable ASCII and at most 255 characters', () => {
    expect(ec2Text('scanner flagged it — stealer 🔥\n2.0.1')).toBe('scanner flagged it ? stealer ? 2.0.1');
    expect(ec2Text('x'.repeat(400))).toHaveLength(255);
  });

  it('tags the instance with when, who and why', () => {
    expect(quarantineInstanceTags({ at: new Date(at), by: 'admin@example.com', reason: 'credential stealer' })).toEqual([
      { Key: 'Quarantined', Value: at },
      { Key: 'QuarantinedBy', Value: 'admin@example.com' },
      { Key: 'QuarantineReason', Value: 'credential stealer' },
    ]);
  });

  it('marks every snapshot Retain=true, which the nightly snapshot prune honours', () => {
    const tags = quarantineSnapshotTags({
      at: new Date(at), by: 'admin@example.com', reason: 'r', managedTag: 'termag-box',
      ec2InstanceId: 'i-0123456789abcdef0', boxName: 'jackbox01', device: '/dev/sda1',
    });
    expect(tags).toEqual(expect.arrayContaining([
      { Key: 'App', Value: 'termag' },
      { Key: 'Retain', Value: 'true' },
      { Key: 'ManagedBy', Value: 'termag-box' },
      { Key: 'QuarantinedInstance', Value: 'i-0123456789abcdef0' },
      { Key: 'Name', Value: 'quarantine-jackbox01-sda1' },
    ]));
  });
});

describe('snapshotTargets', () => {
  it('lists every attached EBS volume and nothing else', () => {
    expect(snapshotTargets([
      { DeviceName: '/dev/sda1', Ebs: { VolumeId: 'vol-root' } },
      { DeviceName: '/dev/sdb' },
      { DeviceName: '/dev/sdf', Ebs: { VolumeId: 'vol-data' } },
    ])).toEqual([{ volumeId: 'vol-root', device: '/dev/sda1' }, { volumeId: 'vol-data', device: '/dev/sdf' }]);
    expect(snapshotTargets(undefined)).toEqual([]);
  });
});

describe('needsStop', () => {
  it('stops only what is up or coming up', () => {
    expect(needsStop('running')).toBe(true);
    expect(needsStop('pending')).toBe(true);
    for (const s of ['stopping', 'stopped', 'shutting-down', 'terminated', undefined]) expect(needsStop(s)).toBe(false);
  });
});

describe('needsContainmentRun', () => {
  const now = Date.parse('2026-10-23T20:00:00Z');
  const all = (over: Partial<Record<QuarantineStepResult['step'], QuarantineStepResult>> = {}) =>
    QUARANTINE_STEPS.map(step => over[step] ?? result(step, 'done'));
  const box = (extra: Record<string, unknown> = {}) => ({
    status: 'quarantined', kind: 'ec2', ec2InstanceId: 'i-1', quarantinedAt: new Date(now - 30 * 60_000),
    quarantineSteps: all({ stop: { step: 'stop', outcome: 'skipped', detail: NO_INSTANCE_YET, at } }), ...extra,
  });

  it('picks a box whose run skipped its AWS steps for want of the instance it now has', () => {
    expect(needsContainmentRun(box(), now)).toBe(true);
  });

  it('picks a run cut short before it recorded anything, part way through its steps, or mid-snapshot', () => {
    expect(needsContainmentRun(box({ quarantineSteps: null }), now)).toBe(true);
    expect(needsContainmentRun(box({ quarantineSteps: all().slice(0, 4) }), now)).toBe(true);
    const midSnapshot = { step: 'snapshot' as const, outcome: 'failed' as const, detail: `${SNAPSHOT_IN_PROGRESS} snap-1`, at };
    expect(needsContainmentRun(box({ quarantineSteps: all({ snapshot: midSnapshot }) }), now)).toBe(true);
  });

  it('leaves a contained box, a step that ran and failed, a box with no instance, a fresh claim and anything not quarantined', () => {
    expect(needsContainmentRun(box({ quarantineSteps: all() }), now)).toBe(false);
    expect(needsContainmentRun(box({ quarantineSteps: all({ stop: { step: 'stop', outcome: 'skipped', detail: 'EC2 already reports it stopped', at } }) }), now)).toBe(false);
    expect(needsContainmentRun(box({ quarantineSteps: all({ snapshot: { step: 'snapshot', outcome: 'failed', detail: 'failed: UnauthorizedOperation', at } }) }), now)).toBe(false);
    expect(needsContainmentRun(box({ ec2InstanceId: null }), now)).toBe(false);
    expect(needsContainmentRun(box({ quarantinedAt: new Date(now - LAUNCH_FOLLOW_UP_SETTLE_MS + 1000) }), now)).toBe(false);
    expect(needsContainmentRun(box({ status: 'terminated' }), now)).toBe(false);
    expect(needsContainmentRun(box({ kind: 'external' }), now)).toBe(false);
  });
});

describe('stopUnsettled', () => {
  it('waits out a running or stopping instance, and nothing that is down', () => {
    for (const s of ['running', 'pending', 'stopping']) expect(stopUnsettled(s)).toBe(true);
    for (const s of ['stopped', 'shutting-down', 'terminated', undefined]) expect(stopUnsettled(s)).toBe(false);
  });
});
