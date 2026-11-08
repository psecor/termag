import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db', () => ({ prisma: {} }));

import { MemorySpaceStore } from '../spaces/spacesTestkit';
import { enable } from './enable';
import { MemorySpaceSlackStore } from './spaceSlackTestkit';

let spaces: MemorySpaceStore;
let slack: MemorySpaceSlackStore;
const project = vi.fn(async () => null);

beforeEach(() => {
  spaces = new MemorySpaceStore();
  slack = new MemorySpaceSlackStore();
  spaces.addUser('u-own');
  spaces.addUser('u-other');
  project.mockClear();
});

describe('enable', () => {
  it('records the runner and a new small box, with the project stubbed until M7', async () => {
    const res = await enable({ spaces, slack, ensureOrchestratorProject: project }, { spaceId: 's1', actorUserId: 'u-own', box: { new: { size: 'small' } }, via: 'web' });
    expect(res).toMatchObject({ kind: 'enabled', created: true, spaceSlack: { runnerUserId: 'u-own', enabledById: 'u-own', instanceId: null, projectId: null } });
    expect(spaces.eventRows).toMatchObject([{ action: 'slack.enable', surface: 'slack', note: 'linkedVia=web; runner=u-own; box=new:small' }]);
    expect(project).toHaveBeenCalledTimes(1);
  });

  it('records an existing box the runner owns', async () => {
    spaces.addBox('i-mine', 'u-own');
    const res = await enable({ spaces, slack }, { spaceId: 's1', actorUserId: 'u-own', box: { existing: 'i-mine' }, via: 'cli' });
    expect(res).toMatchObject({ kind: 'enabled', spaceSlack: { instanceId: 'i-mine' } });
    expect(spaces.eventRows[0].note).toBe('linkedVia=cli; runner=u-own; box=existing:i-mine');
  });

  it('refuses someone else\'s box and a terminated one', async () => {
    spaces.addBox('i-theirs', 'u-other');
    spaces.addBox('i-dead', 'u-own', 'i-dead', 'terminated');
    for (const id of ['i-theirs', 'i-dead', 'i-missing']) {
      expect(await enable({ spaces, slack }, { spaceId: 's1', actorUserId: 'u-own', box: { existing: id }, via: 'web' })).toEqual({ kind: 'refused', code: 'runner_no_box' });
    }
    expect(slack.slack.size).toBe(0);
  });

  it('a second enable keeps the first runner and records nothing', async () => {
    await enable({ spaces, slack, ensureOrchestratorProject: project }, { spaceId: 's1', actorUserId: 'u-own', box: { new: { size: 'small' } }, via: 'web' });
    const res = await enable({ spaces, slack, ensureOrchestratorProject: project }, { spaceId: 's1', actorUserId: 'u-other', box: { new: { size: 'small' } }, via: 'web' });
    expect(res).toMatchObject({ kind: 'enabled', created: false, spaceSlack: { runnerUserId: 'u-own' } });
    expect(spaces.eventRows).toHaveLength(1);
    expect(project).toHaveBeenCalledTimes(1);
  });

  it('refuses a failed or quarantined box, and takes a stopped or hibernated one (it can be woken)', async () => {
    for (const status of ['failed', 'quarantined']) {
      spaces.addBox(`i-${status}`, 'u-own', `i-${status}`, status);
      expect(await enable({ spaces, slack }, { spaceId: 's1', actorUserId: 'u-own', box: { existing: `i-${status}` }, via: 'web' })).toEqual({ kind: 'refused', code: 'runner_no_box' });
    }
    spaces.addBox('i-stopped', 'u-own', 'i-stopped', 'stopped');
    expect(await enable({ spaces, slack }, { spaceId: 's1', actorUserId: 'u-own', box: { existing: 'i-stopped' }, via: 'web' })).toMatchObject({ kind: 'enabled', spaceSlack: { instanceId: 'i-stopped' } });
    spaces.addBox('i-hib', 'u-own', 'i-hib', 'hibernated');
    expect(await enable({ spaces, slack }, { spaceId: 's2', actorUserId: 'u-own', box: { existing: 'i-hib' }, via: 'web' })).toMatchObject({ kind: 'enabled' });
  });

  it('a repeat on a space already on is the no-op, whatever box it names (a first-link race\'s loser)', async () => {
    await enable({ spaces, slack }, { spaceId: 's1', actorUserId: 'u-own', box: { new: { size: 'small' } }, via: 'web' });
    for (const box of [{ existing: 'i-missing' }, { existing: 'i-theirs' }]) {
      spaces.addBox('i-theirs', 'u-other');
      expect(await enable({ spaces, slack }, { spaceId: 's1', actorUserId: 'u-other', box, via: 'web' })).toMatchObject({ kind: 'enabled', created: false, spaceSlack: { runnerUserId: 'u-own' } });
    }
  });

  it('a project step that failed is finished by the next enable, and neither failure undoes the row', async () => {
    spaces.addBox('i-mine', 'u-own');
    const flaky = vi.fn<(i: unknown) => Promise<{ projectId: string } | null>>()
      .mockRejectedValueOnce(new Error('box timed out')).mockResolvedValue({ projectId: 'p1' });
    vi.spyOn(spaces, 'recordEvent').mockRejectedValueOnce(new Error('db blip'));
    const first = await enable({ spaces, slack, ensureOrchestratorProject: flaky }, { spaceId: 's1', actorUserId: 'u-own', box: { existing: 'i-mine' }, via: 'web' });
    expect(first).toMatchObject({ kind: 'enabled', created: true });
    // The retry (another link) runs the project step again on the runner's recorded box.
    const retry = await enable({ spaces, slack, ensureOrchestratorProject: flaky }, { spaceId: 's1', actorUserId: 'u-other', box: { new: { size: 'small' } }, via: 'web' });
    expect(retry).toMatchObject({ kind: 'enabled', created: false });
    expect(flaky).toHaveBeenCalledTimes(2);
    expect(flaky.mock.calls[1][0]).toMatchObject({ box: { existing: 'i-mine' } });
  });

  it('activateSpaceSlack writes no audit and makes no project; completeEnable does both', async () => {
    const { activateSpaceSlack, completeEnable } = await import('./enable');
    spaces.addBox('i-mine', 'u-own');
    const input = { spaceId: 's1', actorUserId: 'u-own', box: { existing: 'i-mine' }, via: 'cli' } as const;
    const res = await activateSpaceSlack({ spaces, slack, ensureOrchestratorProject: project }, input);
    expect(spaces.eventRows).toEqual([]);
    expect(project).not.toHaveBeenCalled();
    if (res.kind !== 'enabled') throw new Error('refused');
    await completeEnable({ spaces, slack, ensureOrchestratorProject: project }, input, res);
    expect(spaces.eventRows.map(e => e.action)).toEqual(['slack.enable']);
    expect(project).toHaveBeenCalledTimes(1);
  });
});
