import { describe, it, expect } from 'vitest';
import type { CreateWorkstreamInput } from '../routes/workstreams';
import type { RouteResult } from '../routes/routeResult';
import { createCliWorkstream } from './cliWorkstreams';

function fakeDeps(answers: RouteResult[]) {
  const creates: CreateWorkstreamInput[] = [];
  const located: string[] = [];
  return {
    creates,
    located,
    deps: {
      async create(input: CreateWorkstreamInput) {
        creates.push(input);
        return answers.shift() ?? { status: 500, body: { error: 'unexpected create' } };
      },
      async locate(name: string) {
        located.push(name);
        return { directory: `/home/alice/termag/projects/sample/.worktrees/${name}`, exists: true };
      },
    },
  };
}

const created = (name: string, extra: Record<string, unknown> = {}): RouteResult => ({
  status: 201,
  body: { id: 'w1', projectId: 'p1', name, branch: name, slackChannelId: null, ...extra },
});

describe('createCliWorkstream', () => {
  it("makes the workstream with the shared handler and answers where it is on the box", async () => {
    const { deps, creates, located } = fakeDeps([created('t3-0a1b2c3d', { sessionLaunchWarnings: ['agent: busy'] })]);
    const result = await createCliWorkstream({ name: 't3-0a1b2c3d', base: 'main', agent: 'claude-chat' }, deps);
    expect(creates).toEqual([{ name: 't3-0a1b2c3d', baseRef: 'main', provider: 'claude-chat' }]);
    expect(located).toEqual(['t3-0a1b2c3d']);
    expect(result).toEqual({
      status: 201,
      body: {
        workstream: {
          id: 'w1', name: 't3-0a1b2c3d', branch: 't3-0a1b2c3d',
          directory: '/home/alice/termag/projects/sample/.worktrees/t3-0a1b2c3d', exists: true,
        },
        warnings: ['agent: busy'],
      },
    });
  });

  it('leaves the base and the agent to the handler when none is asked for', async () => {
    const { deps, creates } = fakeDeps([created('fix')]);
    await createCliWorkstream({ name: 'fix' }, deps);
    expect(creates).toEqual([{ name: 'fix' }]);
  });

  it('passes a refusal through without looking for a directory', async () => {
    const refusal = { status: 409, body: { error: 'A workstream with that name already exists' } };
    const { deps, located } = fakeDeps([refusal]);
    expect(await createCliWorkstream({ name: 'fix', base: 'main' }, deps)).toBe(refusal);
    expect(located).toEqual([]);
  });

  it("starts from origin's tip of the base when asked", async () => {
    const { deps, creates } = fakeDeps([created('fix')]);
    await createCliWorkstream({ name: 'fix', base: 'main', startFromOrigin: true }, deps);
    expect(creates).toEqual([{ name: 'fix', baseRef: 'origin/main', fetch: { remoteBranch: 'main' } }]);
  });

  it('branches a base origin does not have as given', async () => {
    const { deps, creates } = fakeDeps([
      { status: 500, body: { error: "git worktree add failed: fatal: invalid reference: origin/local-only" } },
      created('fix'),
    ]);
    const result = await createCliWorkstream({ name: 'fix', base: 'local-only', startFromOrigin: true }, deps);
    expect(result.status).toBe(201);
    expect(creates).toEqual([
      { name: 'fix', baseRef: 'origin/local-only', fetch: { remoteBranch: 'local-only' } },
      { name: 'fix', baseRef: 'local-only' },
    ]);
  });

  it('does not retry any other failure from origin', async () => {
    const { deps, creates } = fakeDeps([
      { status: 503, body: { error: 'Box agent is not connected' } },
      { status: 500, body: { error: "git worktree add failed: fatal: '/x/.worktrees/fix' already exists" } },
    ]);
    expect((await createCliWorkstream({ name: 'fix', base: 'main', startFromOrigin: true }, deps)).status).toBe(503);
    expect((await createCliWorkstream({ name: 'fix', base: 'main', startFromOrigin: true }, deps)).status).toBe(500);
    expect(creates).toHaveLength(2);
  });

  it('uses a remote base, or no base, as given even from origin', async () => {
    const { deps, creates } = fakeDeps([created('a'), created('b')]);
    await createCliWorkstream({ name: 'a', base: 'origin/main', startFromOrigin: true }, deps);
    await createCliWorkstream({ name: 'b', startFromOrigin: true }, deps);
    expect(creates).toEqual([{ name: 'a', baseRef: 'origin/main' }, { name: 'b' }]);
  });
});
