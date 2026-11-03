import { describe, expect, it, vi } from 'vitest';
import type { Instance, Project } from '../types';
import {
  cloneFor, cloneForReview, cloneProgressText, isCheckoutNotLanded, reviewCloneBox, reviewProjectName, unreadyCloneOf, untilCheckedOut, type CloneDeps,
} from './reviewClone';

type Box = Pick<Instance, 'id' | 'name' | 'status' | 'kind' | 'ec2InstanceId'>;
const box = (id: string, status: Instance['status']): Box => ({ id, name: id, status, kind: 'ec2', ec2InstanceId: `i-${id}` });
const proj = (over: Partial<Project>): Project => ({ id: 'p', name: 'p', instanceId: null, lastActiveAt: undefined, ...over } as Project);

describe('reviewCloneBox', () => {
  it('takes the box of your most recently active project when it is up', () => {
    const boxes = [box('a', 'ready'), box('b', 'ready')];
    const projects = [proj({ instanceId: 'a', lastActiveAt: '2026-11-01T00:00:00Z' }), proj({ instanceId: 'b', lastActiveAt: '2026-11-02T00:00:00Z' })];
    expect(reviewCloneBox(boxes, projects)).toEqual({ box: boxes[1], wake: false });
  });

  it('takes any box that is up before waking one, and a collaborator’s project says nothing', () => {
    const boxes = [box('asleep', 'hibernated'), box('up', 'ready')];
    const projects = [proj({ instanceId: 'asleep', lastActiveAt: '2026-11-02T00:00:00Z' }), proj({ instanceId: 'up', role: 'collaborator', lastActiveAt: '2026-11-03T00:00:00Z' })];
    expect(reviewCloneBox(boxes, projects)?.box.id).toBe('up');
  });

  it('takes a box still coming up, then one starting (waited for), then wakes the most recent asleep one, else none', () => {
    expect(reviewCloneBox([box('a', 'stopped'), box('b', 'awaiting-agent')], [])).toEqual({ box: box('b', 'awaiting-agent'), wake: false });
    expect(reviewCloneBox([box('a', 'stopped'), box('b', 'starting')], [])).toEqual({ box: box('b', 'starting'), wake: true });
    const asleep = [box('old', 'stopped'), box('new', 'hibernated')];
    expect(reviewCloneBox(asleep, [proj({ instanceId: 'new', lastActiveAt: '2026-11-02T00:00:00Z' })])).toEqual({ box: asleep[1], wake: true });
    expect(reviewCloneBox([box('x', 'failed'), box('y', 'stopping')], [])).toBeNull();
    expect(reviewCloneBox([{ ...box('local', 'stopped'), kind: 'local' as Instance['kind'], ec2InstanceId: null }], [])).toBeNull();
  });
});

describe('reviewProjectName', () => {
  it('is the repository’s name, made fit for a project name and free', () => {
    expect(reviewProjectName('example-org/terraform', [])).toBe('terraform');
    expect(reviewProjectName('acme/my.web app', [])).toBe('my-web-app');
    expect(reviewProjectName('acme/terraform', ['Terraform'])).toBe('terraform-2');
    expect(reviewProjectName('acme/metaterm', [])).toBe('metaterm-review');
    expect(reviewProjectName('acme/...', [])).toBe('review');
  });
});

function deps(over: Partial<CloneDeps> & { statuses?: Array<Project['setupStatus']> } = {}): CloneDeps & { created: unknown[] } {
  const statuses = [...(over.statuses ?? ['pending', 'cloning', 'ready'])];
  const created: unknown[] = [];
  let made: Project | null = null;
  return {
    created,
    listBoxes: async () => [],
    startBox: async () => ({}),
    listProjects: async () => {
      const list = [proj({ id: 'mine', name: 'terraform' })];
      if (made) list.push({ ...made, setupStatus: statuses.length > 1 ? statuses.shift()! : statuses[0] });
      return list;
    },
    createProject: async data => { created.push(data); made = proj({ id: 'new', name: data.name }); return made; },
    retryClone: async () => ({}),
    sleep: async () => {},
    now: () => 0,
    ...over,
  };
}

describe('cloneForReview', () => {
  it('makes a project with the repository and waits for its clone', async () => {
    const d = deps();
    const seen: string[] = [];
    const out = await cloneForReview('example-org/terraform', { box: { id: 'b1', name: 'box-1', status: 'ready' }, wake: false }, d, p => seen.push(p.phase));
    expect(d.created).toEqual([{ name: 'terraform-2', instanceId: 'b1', repoUrl: 'https://github.com/example-org/terraform.git' }]);
    expect(out).toEqual({ projectId: 'new', projectName: 'terraform-2', pane: false });
    expect(seen).toEqual(['creating', 'cloning']);
  });

  it('wakes an asleep box first and waits until it takes projects', async () => {
    const startBox = vi.fn(async () => ({}));
    const states: Instance['status'][] = ['starting', 'starting', 'ready'];
    const d = deps({ startBox, listBoxes: async () => [{ id: 'b1', name: 'box-1', status: states.shift() ?? 'ready' }] });
    const seen: string[] = [];
    await cloneForReview('acme/web', { box: { id: 'b1', name: 'box-1', status: 'hibernated' }, wake: true }, d, p => seen.push(p.phase));
    expect(startBox).toHaveBeenCalledWith('b1');
    expect(seen[0]).toBe('waking');
  });

  it('takes the next name when an archived project holds one', async () => {
    let calls = 0;
    let made: Project | null = null;
    const d = deps({
      createProject: async data => {
        calls++;
        if (calls === 1) throw Object.assign(new Error('x'), { response: { status: 409, data: { code: 'archived-name-taken', archived: { id: 'old', name: data.name, archivedAt: '2026-10-01' } } } });
        made = proj({ id: 'new', name: data.name, setupStatus: 'ready' });
        return made;
      },
      listProjects: async () => (made ? [made] : []),
    });
    expect((await cloneForReview('acme/web', { box: { id: 'b', name: 'b', status: 'ready' }, wake: false }, d)).projectName).toBe('web-2');
  });

  it('says why a clone failed, and gives up on another refusal at once', async () => {
    const d = deps({ statuses: ['cloning', 'failed'] });
    await expect(cloneForReview('acme/web', { box: { id: 'b', name: 'b', status: 'ready' }, wake: false }, d)).rejects.toThrow('The clone of acme/web failed');
    const refused = deps({ createProject: async () => { throw Object.assign(new Error('x'), { response: { status: 403, data: { error: 'Not your box' } } }); } });
    await expect(cloneForReview('acme/web', { box: { id: 'b', name: 'b', status: 'ready' }, wake: false }, refused)).rejects.toThrow('Not your box');
  });

  it('takes a pane-route box’s `none` as cloned, and says so', async () => {
    const d = deps({ statuses: ['none'] });
    await expect(cloneForReview('acme/web', { box: { id: 'b', name: 'b', status: 'ready' }, wake: false }, d)).resolves.toEqual({ projectId: 'new', projectName: 'web', pane: true });
  });

  it('waits on a project already cloning the repository rather than making another', async () => {
    const statuses: Array<Project['setupStatus']> = ['cloning', 'cloning', 'ready'];
    const createProject = vi.fn();
    const d = deps({
      createProject,
      listBoxes: async () => [{ id: 'b1', name: 'box-1', status: 'ready' }],
      listProjects: async () => [proj({ id: 'tf', name: 'terraform', repoUrl: 'https://github.com/example-org/terraform.git', instanceId: 'b1', setupStatus: statuses.length > 1 ? statuses.shift()! : statuses[0] })],
    });
    await expect(cloneForReview('example-org/terraform', null, d)).resolves.toEqual({ projectId: 'tf', projectName: 'terraform', pane: false });
    expect(createProject).not.toHaveBeenCalled();
  });

  it('runs a failed clone again, waking its box first', async () => {
    const retryClone = vi.fn(async (_id: string) => ({}));
    const startBox = vi.fn(async () => ({}));
    let retried = false;
    const boxStates: Instance['status'][] = ['hibernated', 'starting', 'ready'];
    const d = deps({
      retryClone: async id => { retried = true; return retryClone(id); },
      startBox,
      listBoxes: async () => [{ id: 'b1', name: 'box-1', status: boxStates.length > 1 ? boxStates.shift()! : boxStates[0] }],
      listProjects: async () => [proj({ id: 'tf', name: 'terraform', repoUrl: 'git@github.com:example-org/terraform.git', instanceId: 'b1', setupStatus: retried ? 'ready' : 'failed' })],
    });
    await expect(cloneForReview('example-org/terraform', null, d)).resolves.toMatchObject({ projectId: 'tf' });
    expect(startBox).toHaveBeenCalledWith('b1');
    expect(retryClone).toHaveBeenCalledWith('tf');
  });

  it('needs a box when there is no project to use', async () => {
    await expect(cloneForReview('acme/web', null, deps())).rejects.toThrow('No box to clone acme/web on');
  });
});

describe('unreadyCloneOf', () => {
  const on = (id: string, setupStatus: Project['setupStatus'], at = '2026-11-01T00:00:00Z') => proj({ id, repoUrl: 'https://github.com/acme/web', setupStatus, lastActiveAt: at });
  it('is the project on the repository still cloning or failed, unless another is ready', () => {
    expect(unreadyCloneOf('acme/web', [on('a', 'cloning')])?.id).toBe('a');
    expect(unreadyCloneOf('acme/web', [on('a', 'failed'), on('b', 'ready')])).toBeNull();
    expect(unreadyCloneOf('acme/web', [on('a', 'none')])).toBeNull();
    expect(unreadyCloneOf('acme/web', [{ ...on('a', 'cloning'), role: 'collaborator' } as Project])).toBeNull();
    expect(unreadyCloneOf('acme/other', [on('a', 'cloning')])).toBeNull();
  });
});

describe('untilCheckedOut', () => {
  const landing = Object.assign(new Error('x'), { response: { status: 409, data: { error: "This project's repository is not checked out yet. Wait for the checkout in its main terminal to finish, or re-run it there." } } });
  const clock = () => { let t = 0; return { sleep: async (ms: number) => { t += ms; }, now: () => t }; };

  it('tries a branch off a pane checkout again while it lands', async () => {
    let calls = 0;
    const waits = vi.fn();
    const out = await untilCheckedOut(async () => { if (++calls < 3) throw landing; return 'made'; }, true, clock(), waits);
    expect(out).toBe('made');
    expect(waits).toHaveBeenCalledTimes(2);
    expect(isCheckoutNotLanded(landing)).toBe(true);
  });

  it('throws at once off a checkout that came back ready, or for any other refusal', async () => {
    await expect(untilCheckedOut(async () => { throw landing; }, false, clock())).rejects.toBe(landing);
    const other = Object.assign(new Error('y'), { response: { status: 409, data: { error: 'Workstream exists' } } });
    await expect(untilCheckedOut(async () => { throw other; }, true, clock())).rejects.toBe(other);
  });

  it('gives up after a quarter of an hour', async () => {
    await expect(untilCheckedOut(async () => { throw landing; }, true, clock())).rejects.toBe(landing);
  });
});

describe('cloneFor', () => {
  it('runs one clone per repository, whatever its case', async () => {
    const d = deps();
    const pick = { box: { id: 'b', name: 'b', status: 'ready' as const }, wake: false };
    const [a, b] = await Promise.all([cloneFor('Acme/Web', pick, d), cloneFor('acme/web', pick, d)]);
    expect(a).toEqual(b);
    expect(d.created).toHaveLength(1);
  });
});

describe('cloneProgressText', () => {
  it('names the box, the repository and the project', () => {
    expect(cloneProgressText({ repo: 'acme/web', box: 'box-1', phase: 'waking' })).toBe('Waking box-1 to clone acme/web…');
    expect(cloneProgressText({ repo: 'acme/web', box: 'box-1', phase: 'cloning', projectName: 'web' })).toBe('Cloning acme/web into web on box-1…');
    expect(cloneProgressText({ repo: 'acme/web', box: '', phase: 'checkout', projectName: 'web' })).toBe('Waiting for web\'s checkout to land…');
  });
});
