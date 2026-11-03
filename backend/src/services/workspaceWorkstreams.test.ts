import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendForProject = vi.fn();
vi.mock('./agentRegistry', () => ({ sendForProject }));
vi.mock('./workspaceSetup', () => ({
  workspaceRoot: (_p: unknown, ws = 'main') => (ws === 'main' ? '/h/p' : `/h/p/.worktrees/${ws}`),
  writeGuide: vi.fn(async () => {}),
}));

const { buildWorkstreamTree, removeWorkstreamTree, workspacePrRepo } = await import('./workspaceWorkstreams');
const { writeGuide } = await import('./workspaceSetup');

const project = { id: 'p1', name: 'p', userId: 'u1', instanceId: 'i1', user: { unixUsername: 'alice' }, instance: { hostHome: '/h' } };
const repos = [{ name: 'api', url: 'https://github.com/o/api', position: 0 }, { name: 'web', url: 'https://github.com/o/web', position: 1 }];
const ws = { name: 'fix', branch: 'ccs/fix' };

type Handler = (payload: Record<string, unknown>) => unknown;
function box(handlers: Record<string, Handler>) {
  sendForProject.mockImplementation(async (_host: unknown, command: string, payload: Record<string, unknown>) => {
    const h = handlers[command];
    if (!h) return { ok: true };
    return h(payload);
  });
}
const sent = (command: string) => sendForProject.mock.calls.filter(c => c[1] === command).map(c => c[2] as Record<string, unknown>);

beforeEach(() => { sendForProject.mockReset(); });

describe('buildWorkstreamTree', () => {
  it('undoes only the worktrees it made when a later repository fails', async () => {
    box({
      'git-worktree-add': p => {
        if (p.worktreePath === '/h/p/.worktrees/fix/web') throw new Error('invalid reference');
        return { ok: true };
      },
    });
    const built = await buildWorkstreamTree(project, repos, 'fix', 'ccs/fix', 'HEAD');
    expect(built).toEqual({ ok: false, error: 'web: invalid reference' });
    expect(sent('git-worktree-remove').map(p => p.worktreePath)).toEqual(['/h/p/.worktrees/fix/api']);
    expect(sent('workspace-root-remove')).toEqual([{ wsRoot: '/h/p/.worktrees/fix' }]);
  });

  it('undoes the worktrees it made and the root when the guide cannot be written', async () => {
    box({ 'git-worktree-add': p => (p.worktreePath === '/h/p/.worktrees/fix/api' ? { ok: true, existing: true } : { ok: true }) });
    vi.mocked(writeGuide).mockRejectedValueOnce(new Error('Agent request timed out: init-workspace'));
    const built = await buildWorkstreamTree(project, repos, 'fix', 'ccs/fix', 'HEAD');
    expect(built).toEqual({ ok: false, error: 'the workstream guide: Agent request timed out: init-workspace' });
    expect(sent('git-worktree-remove').map(p => [p.worktreePath, p.force])).toEqual([['/h/p/.worktrees/fix/web', true]]);
    expect(sent('workspace-root-remove')).toEqual([{ wsRoot: '/h/p/.worktrees/fix' }]);
  });

  it('answers an error rather than throwing when the root cannot be made', async () => {
    box({ 'init-workspace': () => { throw new Error('Box agent is not connected'); } });
    const built = await buildWorkstreamTree(project, repos, 'fix', 'ccs/fix', 'HEAD');
    expect(built).toEqual({ ok: false, error: 'the workstream root: Box agent is not connected' });
    expect(sent('git-worktree-add')).toEqual([]);
  });

  it('never counts a worktree it found already there as its own', async () => {
    box({ 'git-worktree-add': p => (p.worktreePath === '/h/p/.worktrees/fix/api' ? { ok: true, existing: true } : { ok: true }) });
    expect(await buildWorkstreamTree(project, repos, 'fix', 'ccs/fix', 'HEAD')).toEqual({ ok: true, made: ['web'] });
  });
});

describe('workspacePrRepo', () => {
  it('finds the PR\'s repository by owner/name, whatever its case', () => {
    expect(workspacePrRepo('p', repos, { repo: 'O/Web', number: 12 })).toEqual({ ok: true, repo: repos[1] });
  });
  it('refuses a repository the project does not hold, naming the ones it does', () => {
    expect(workspacePrRepo('p', repos, { repo: 'o/docs', number: 12 })).toEqual({
      ok: false, error: 'p holds o/api, o/web, not o/docs. Make a project for o/docs (or un-archive one), then try again.',
    });
  });
  it('refuses a bare number, which could be in any of them, as the Review pane does', () => {
    expect(workspacePrRepo('p', [repos[1], repos[0]], { repo: null, number: 12 })).toEqual({
      ok: false, error: 'p holds several repositories (o/api, o/web), so PR #12 could be in any of them. Use the PR\'s URL or owner/repo#12.',
    });
  });
});

describe('buildWorkstreamTree with a pull request', () => {
  const pr = { repoName: 'web', number: 12, sameRepo: true, headOid: 'b'.repeat(40) };

  it('checks the PR out in its repository first, then branches the others off onto its branch', async () => {
    box({});
    expect(await buildWorkstreamTree(project, repos, 'fix', 'feat/x', 'HEAD', pr)).toEqual({ ok: true, made: ['web', 'api'] });
    const calls = sendForProject.mock.calls.filter(c => c[1] === 'git-worktree-add-pr' || c[1] === 'git-worktree-add');
    expect(calls.map(c => [c[1], (c[2] as Record<string, unknown>).worktreePath, c[3]])).toEqual([
      ['git-worktree-add-pr', '/h/p/.worktrees/fix/web', 600_000],
      ['git-worktree-add', '/h/p/.worktrees/fix/api', 30_000],
    ]);
    expect(sent('git-worktree-add-pr')[0]).toEqual({
      projectDir: '/h/p/web', worktreeName: 'fix', worktreePath: '/h/p/.worktrees/fix/web', branch: 'feat/x', number: 12, sameRepo: true, headOid: 'b'.repeat(40),
    });
    expect(sent('git-worktree-add')[0]).toMatchObject({ projectDir: '/h/p/api', branch: 'feat/x', baseRef: 'HEAD', initRepo: false });
    expect(writeGuide).toHaveBeenLastCalledWith(project, repos, 'fix', 'feat/x');
  });

  it('adds nothing else when the PR cannot be checked out', async () => {
    box({ 'git-worktree-add-pr': () => { throw new Error('this project is not a checkout of the PR\'s repository'); } });
    expect(await buildWorkstreamTree(project, repos, 'fix', 'feat/x', 'HEAD', pr)).toEqual({ ok: false, error: 'web: this project is not a checkout of the PR\'s repository' });
    expect(sent('git-worktree-add')).toEqual([]);
    expect(sent('workspace-root-remove')).toEqual([{ wsRoot: '/h/p/.worktrees/fix' }]);
  });

  it('on a later failure removes the PR\'s worktree but never its branch', async () => {
    box({ 'git-worktree-add': () => { throw new Error("a branch named 'feat/x' already exists"); } });
    expect(await buildWorkstreamTree(project, repos, 'fix', 'feat/x', 'HEAD', pr)).toEqual({ ok: false, error: "api: a branch named 'feat/x' already exists" });
    expect(sent('git-worktree-remove').map(p => [p.worktreePath, p.branch])).toEqual([['/h/p/.worktrees/fix/web', undefined]]);
  });

  it('never counts a PR worktree it found already there as its own', async () => {
    box({ 'git-worktree-add-pr': () => ({ ok: true, existing: true }) });
    expect(await buildWorkstreamTree(project, repos, 'fix', 'feat/x', 'HEAD', pr)).toEqual({ ok: true, made: ['api'] });
  });
});

describe('removeWorkstreamTree without force', () => {
  const state = (present: string[], leftovers: string[] = []) => () => ({ exists: true, present, leftovers });

  it('refuses when any repository is dirty, before removing anything', async () => {
    box({ 'workspace-root-state': state(['api', 'web']), 'git-branch-state': p => ({ dirty: p.cwd === '/h/p/.worktrees/fix/web' }) });
    const removed = await removeWorkstreamTree(project, repos, ws, { force: false });
    expect(removed).toMatchObject({ ok: false, status: 409, error: expect.stringContaining('uncommitted changes: web') });
    expect(sent('git-worktree-remove')).toEqual([]);
    expect(sent('workspace-root-remove')).toEqual([]);
  });

  it('refuses when a repository cannot be read, rather than calling it clean', async () => {
    box({
      'workspace-root-state': state(['api', 'web']),
      'git-branch-state': p => { if (p.cwd === '/h/p/.worktrees/fix/api') throw new Error('Agent request timed out: git-branch-state'); return { dirty: false }; },
    });
    const removed = await removeWorkstreamTree(project, repos, ws, { force: false });
    expect(removed).toMatchObject({ ok: false, status: 409, error: expect.stringContaining('could not be checked: api') });
    expect(sent('git-worktree-remove')).toEqual([]);
  });

  it('refuses when the folder holds files outside every repository, naming them', async () => {
    box({ 'workspace-root-state': state(['api', 'web'], ['.claude', 'notes.md']), 'git-branch-state': () => ({ dirty: false }) });
    const removed = await removeWorkstreamTree(project, repos, ws, { force: false });
    expect(removed).toMatchObject({ ok: false, status: 409, error: expect.stringContaining('.claude, notes.md') });
    expect(sent('git-worktree-remove')).toEqual([]);
  });

  it('counts a worktree whose directory is gone as removed, and removes the rest', async () => {
    box({ 'workspace-root-state': state(['web']), 'git-branch-state': () => ({ dirty: false }) });
    expect(await removeWorkstreamTree(project, repos, ws, { force: false })).toEqual({ ok: true, warnings: [] });
    expect(sent('git-branch-state').map(p => p.cwd)).toEqual(['/h/p/.worktrees/fix/web']);
    expect(sent('git-worktree-remove').map(p => [p.worktreePath, p.force])).toEqual([['/h/p/.worktrees/fix/api', false], ['/h/p/.worktrees/fix/web', false]]);
    expect(sent('workspace-root-remove')).toEqual([{ wsRoot: '/h/p/.worktrees/fix', force: false }]);
  });

  it('refuses when the box cannot say what the folder holds', async () => {
    box({ 'workspace-root-state': () => { throw new Error('Unknown command: workspace-root-state'); } });
    expect(await removeWorkstreamTree(project, repos, ws, { force: false })).toMatchObject({ ok: false, status: 409 });
    expect(sent('git-worktree-remove')).toEqual([]);
  });
});

describe('removeWorkstreamTree with force', () => {
  it('checks nothing and removes every worktree and the folder with what it held', async () => {
    box({ 'git-worktree-remove': p => ({ branchDeleteWarning: p.worktreePath === '/h/p/.worktrees/fix/web' ? 'not fully merged' : null }) });
    expect(await removeWorkstreamTree(project, repos, ws, { force: true })).toEqual({ ok: true, warnings: ['web: not fully merged'] });
    expect(sent('workspace-root-state')).toEqual([]);
    expect(sent('git-worktree-remove').every(p => p.force === true && p.branch === 'ccs/fix')).toBe(true);
    expect(sent('workspace-root-remove')).toEqual([{ wsRoot: '/h/p/.worktrees/fix', force: true }]);
  });
});
