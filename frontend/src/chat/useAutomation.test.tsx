// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AutomationDetailView } from './useAutomation';
import { automation } from './automationsView.fixtures';

const api = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../services/api', async importOriginal => ({
  ...(await importOriginal<typeof import('../services/api')>()),
  automationsApi: { get: api.get },
}));

import { useAutomation } from './useAutomation';

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const detailA: AutomationDetailView = { ...automation({ id: 'a1', projectId: 'p1', projectName: 'alpha' }), runs: [] };
const detailB: AutomationDetailView = { ...automation({ id: 'a2', projectId: 'p2', projectName: 'beta' }), runs: [] };

type Hook = ReturnType<typeof useAutomation>;
let seen: Hook;
function Probe({ id }: { id: string }) {
  seen = useAutomation(id, true);
  return null;
}

let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  root = createRoot(document.createElement('div'));
  api.get.mockReset();
});
afterEach(() => { act(() => root.unmount()); });

describe('useAutomation', () => {
  it('drops a slow answer for the automation the page showed before the id changed', async () => {
    const slowA = deferred<AutomationDetailView>();
    api.get.mockImplementation((id: string) => (id === 'p1' ? slowA.promise : Promise.resolve(detailB)));
    await act(async () => root.render(<Probe id="p1" />));
    await act(async () => root.render(<Probe id="p2" />));
    expect(seen.detail?.projectName).toBe('beta');
    await act(async () => slowA.resolve(detailA));
    expect(seen.detail?.projectName).toBe('beta');
  });

  it('drops an older answer for the same id that lands after a newer one', async () => {
    const first = deferred<AutomationDetailView>();
    api.get.mockReturnValueOnce(first.promise).mockResolvedValueOnce({ ...detailA, projectName: 'alpha v2' });
    await act(async () => root.render(<Probe id="p1" />));
    await act(async () => { await seen.reload(); });
    expect(seen.detail?.projectName).toBe('alpha v2');
    await act(async () => first.resolve({ ...detailA, projectName: 'alpha v1' }));
    expect(seen.detail?.projectName).toBe('alpha v2');
  });

  it('ignores a reload asked for the previous id (an action that finished after the URL changed)', async () => {
    api.get.mockImplementation((id: string) => Promise.resolve(id === 'p1' ? detailA : detailB));
    await act(async () => root.render(<Probe id="p1" />));
    const staleReload = seen.reload;
    await act(async () => root.render(<Probe id="p2" />));
    api.get.mockClear();
    await act(async () => { await staleReload(); });
    expect(api.get).not.toHaveBeenCalled();
    expect(seen.detail?.projectName).toBe('beta');
  });

  it('keeps the last detail when a reload fails, with the error beside it', async () => {
    api.get.mockResolvedValueOnce(detailA).mockRejectedValueOnce({ response: { data: { error: 'box unreachable' } } });
    await act(async () => root.render(<Probe id="p1" />));
    await act(async () => { await seen.reload(); });
    expect(seen.detail?.projectName).toBe('alpha');
    expect(seen.error).toBe('box unreachable');
  });
});
