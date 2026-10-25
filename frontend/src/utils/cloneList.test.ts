import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { cloneInFlight, cloneTile } from './cloneTile';
import {
  applyCloneAction,
  applyListRead,
  beginListRead,
  releaseListRead,
  settleCloneAction,
  type CloneListState,
  type CloneRow,
} from './cloneList';

const failed: CloneRow = {
  id: 'p',
  setupStatus: 'failed',
  setupError: 'fatal: repository not found',
  repoUrl: 'https://github.com/acme/widgets',
  repoDefaultBranch: 'main',
};

describe('applyListRead', () => {
  it('keeps the newer list when an older reload returns last', () => {
    let state: CloneListState<typeof failed> = { generation: 0, projects: [failed] };
    const first = beginListRead(state.generation);
    state = { ...state, generation: first };
    const second = beginListRead(state.generation);
    state = { ...state, generation: second };
    const ready = [{ ...failed, setupStatus: 'ready', setupError: null }];
    const cloning = [{ ...failed, setupStatus: 'cloning', setupError: null }];
    state = applyListRead(state, { generation: second, projects: ready });
    state = applyListRead(state, { generation: first, projects: cloning });
    expect(state.projects).toEqual(ready);
    expect(cloneInFlight(state.projects[0].setupStatus)).toBe(false);
  });

  it('shows nothing yet when the first of two open reads returns first, so the list is not loaded', () => {
    let state: CloneListState<typeof failed> = { generation: 0, projects: [] };
    const first = beginListRead(state.generation);
    state = { ...state, generation: first };
    const second = beginListRead(state.generation);
    state = { ...state, generation: second };
    state = applyListRead(state, { generation: first, projects: [failed] });
    expect(state.projects).toEqual([]);
    expect(state.applied).toBeUndefined();
    state = applyListRead(state, { generation: second, projects: [failed] });
    expect(state.projects).toEqual([failed]);
    expect(state.applied).toBe(second);
  });

  it('drops a list that started before Retry, so the row stays pending', () => {
    let state: CloneListState<typeof failed> = { generation: 0, projects: [failed] };
    const inflight = beginListRead(state.generation);
    state = { ...state, generation: inflight };
    state = applyCloneAction(state, 'p', 'retry', { setupStatus: 'pending' });
    state = applyListRead(state, { generation: inflight, projects: [failed] });
    expect(state.projects[0].setupStatus).toBe('pending');
    expect(state.projects[0].setupError).toBeNull();
    expect(cloneInFlight(state.projects[0].setupStatus)).toBe(true);
  });

  it('applies an older success when the newer list read fails', () => {
    const cloning = [{ ...failed, setupStatus: 'cloning', setupError: null }];
    let state: CloneListState<CloneRow> = { generation: 0, projects: cloning, applied: 0 };
    const older = beginListRead(state.generation);
    state = { ...state, generation: older };
    const newer = beginListRead(state.generation);
    state = { ...state, generation: newer };
    const ready = [{ ...failed, setupStatus: 'ready', setupError: null }];
    state = applyListRead(state, { generation: older, projects: ready });
    expect(state.projects).toEqual(cloning);
    state = releaseListRead(state, newer);
    expect(state.projects).toEqual(ready);
    expect(cloneInFlight(state.projects[0].setupStatus)).toBe(false);
  });

  it('applies an older success that returns after the newer read has already failed', () => {
    const cloning = [{ ...failed, setupStatus: 'cloning', setupError: null }];
    let state: CloneListState<CloneRow> = { generation: 0, projects: cloning, applied: 0 };
    const older = beginListRead(state.generation);
    state = { ...state, generation: older };
    const newer = beginListRead(state.generation);
    state = { ...state, generation: newer };
    state = releaseListRead(state, newer);
    const ready = [{ ...failed, setupStatus: 'ready', setupError: null }];
    state = applyListRead(state, { generation: older, projects: ready });
    expect(state.projects).toEqual(ready);
  });

  it('does not let a failed list read rewind a Retry that already moved the row', () => {
    let state: CloneListState<CloneRow> = { generation: 0, projects: [failed], applied: 0 };
    const listed = beginListRead(state.generation);
    state = { ...state, generation: listed };
    state = applyCloneAction(state, 'p', 'retry', { setupStatus: 'pending' });
    state = releaseListRead(state, listed);
    expect(state.projects[0].setupStatus).toBe('pending');
    expect(cloneInFlight(state.projects[0].setupStatus)).toBe(true);
  });
});

describe('settleCloneAction', () => {
  it('moves a retried clone to pending when the follow-up list fails, and polling stays on', async () => {
    let state: CloneListState<typeof failed> = { generation: 2, projects: [failed] };
    const result = await settleCloneAction({
      read: () => state,
      write: next => { state = next; },
      projectId: 'p',
      action: 'retry',
      request: async () => ({ setupStatus: 'pending' }),
      reload: async () => { throw new Error('list down'); },
    });
    expect(result.requestError).toBeNull();
    expect(result.list).toBeNull();
    expect(state.projects[0].setupStatus).toBe('pending');
    expect(state.projects[0].setupError).toBeNull();
    expect(state.projects[0].repoUrl).toBe('https://github.com/acme/widgets');
    expect(cloneInFlight(state.projects[0].setupStatus)).toBe(true);
    const rewind = applyListRead(state, { generation: 2, projects: [failed] });
    expect(rewind.projects[0].setupStatus).toBe('pending');
  });

  it('opens the project when Start empty succeeds and the follow-up list fails', async () => {
    let state: CloneListState<typeof failed> = { generation: 1, projects: [failed] };
    const result = await settleCloneAction({
      read: () => state,
      write: next => { state = next; },
      projectId: 'p',
      action: 'start-empty',
      request: async () => ({ setupStatus: 'none', setupError: null, repoUrl: null, repoDefaultBranch: 'main' }),
      reload: async () => { throw new Error('list down'); },
    });
    expect(result.requestError).toBeNull();
    expect(state.projects[0]).toMatchObject({
      setupStatus: 'none',
      setupError: null,
      repoUrl: null,
      repoDefaultBranch: 'main',
    });
    expect(cloneTile(state.projects[0].setupStatus).holdTerminal).toBe(false);
  });

  it('keeps the failed row and reports the error when Retry is refused', async () => {
    let state: CloneListState<typeof failed> = { generation: 1, projects: [failed] };
    let reloaded = false;
    const refusal = Object.assign(new Error('refused'), {
      response: { data: { error: 'Only a failed clone can be retried.' } },
    });
    const result = await settleCloneAction({
      read: () => state,
      write: next => { state = next; },
      projectId: 'p',
      action: 'retry',
      request: async () => { throw refusal; },
      reload: async () => { reloaded = true; return []; },
    });
    expect(result.requestError).toBe(refusal);
    expect(reloaded).toBe(false);
    expect(state.projects[0].setupStatus).toBe('failed');
    expect(state.projects[0].setupError).toBe('fatal: repository not found');
  });

  it('keeps the previous error when Retry finishes failed and the follow-up list fails', async () => {
    let state: CloneListState<typeof failed> = { generation: 2, projects: [failed] };
    const result = await settleCloneAction({
      read: () => state,
      write: next => { state = next; },
      projectId: 'p',
      action: 'retry',
      request: async () => ({ setupStatus: 'failed' }),
      reload: async () => { throw new Error('list down'); },
    });
    expect(result.requestError).toBeNull();
    expect(result.list).toBeNull();
    expect(state.projects[0].setupStatus).toBe('failed');
    expect(state.projects[0].setupError).toBe('fatal: repository not found');
    expect(cloneInFlight(state.projects[0].setupStatus)).toBe(false);
  });

  it('uses the error Retry returns, and a still-running status keeps polling', async () => {
    let state: CloneListState<typeof failed> = { generation: 1, projects: [failed] };
    await settleCloneAction({
      read: () => state,
      write: next => { state = next; },
      projectId: 'p',
      action: 'retry',
      request: async () => ({ setupStatus: 'failed', setupError: 'disk full' }),
      reload: async () => { throw new Error('list down'); },
    });
    expect(state.projects[0].setupError).toBe('disk full');

    state = { generation: 1, projects: [failed] };
    await settleCloneAction({
      read: () => state,
      write: next => { state = next; },
      projectId: 'p',
      action: 'retry',
      request: async () => ({ setupStatus: 'cloning' }),
      reload: async () => { throw new Error('list down'); },
    });
    expect(state.projects[0].setupStatus).toBe('cloning');
    expect(state.projects[0].setupError).toBeNull();
    expect(cloneInFlight(state.projects[0].setupStatus)).toBe(true);
  });

  it('applies the follow-up list when the newer read fails', async () => {
    let state: CloneListState<CloneRow> = { generation: 0, projects: [failed], applied: 0 };
    const ready = [{ ...failed, setupStatus: 'ready', setupError: null }];
    let newer = 0;
    const result = await settleCloneAction({
      read: () => state,
      write: next => { state = next; },
      projectId: 'p',
      action: 'retry',
      request: async () => ({ setupStatus: 'pending' }),
      reload: async () => {
        newer = beginListRead(state.generation);
        state = { ...state, generation: newer };
        return ready;
      },
    });
    expect(result.requestError).toBeNull();
    expect(result.list).toBeNull();
    expect(state.projects[0].setupStatus).toBe('pending');
    state = releaseListRead(state, newer);
    expect(state.projects).toEqual(ready);
    expect(cloneInFlight(state.projects[0].setupStatus)).toBe(false);
  });

  it('takes a newer list after Retry when that list returns', async () => {
    let state: CloneListState<typeof failed> = { generation: 0, projects: [failed] };
    const cloning = [{ ...failed, setupStatus: 'cloning', setupError: null }];
    const result = await settleCloneAction({
      read: () => state,
      write: next => { state = next; },
      projectId: 'p',
      action: 'retry',
      request: async () => ({ setupStatus: 'pending' }),
      reload: async () => cloning,
    });
    expect(result.requestError).toBeNull();
    expect(result.list).toEqual(cloning);
    expect(state.projects).toEqual(cloning);
    expect(cloneInFlight(state.projects[0].setupStatus)).toBe(true);
  });
});

describe('clone progress layout', () => {
  it('wraps the failed-clone actions so they are not stuck on one unshrinking row', () => {
    const css = readFileSync(new URL('../App.css', import.meta.url), 'utf8');
    const start = css.indexOf('.clone-progress {');
    const end = css.indexOf('}', start);
    const row = css.slice(start, end);
    expect(row).toContain('flex-wrap: wrap');
    expect(row).not.toContain('flex: 1 0 100%');
    expect(row).not.toMatch(/flex-shrink:\s*0/);
    const buttons = css.slice(css.indexOf('.clone-progress .btn-tiny'), css.indexOf('}', css.indexOf('.clone-progress .btn-tiny')));
    expect(buttons).toContain('flex: 0 0 auto');
  });
});
