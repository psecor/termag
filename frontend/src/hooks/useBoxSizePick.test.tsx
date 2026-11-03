// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../services/api', () => ({ instancesApi: { sizes: vi.fn() } }));
const { useBoxSizePick } = await import('./useBoxSizes');

describe('useBoxSizePick: a size pick belongs to the repository it was made with (Bugbot, #883)', () => {
  it('keeps the pick while the repository stays, and drops it when the repository changes', () => {
    let api: ReturnType<typeof useBoxSizePick> = [null, () => {}];
    function Probe({ repo }: { repo: string | null }) { api = useBoxSizePick(repo); return null; }
    const el = document.createElement('div');
    const root = createRoot(el);
    act(() => root.render(<Probe repo="https://github.com/acme/web" />));
    act(() => api[1]('small'));
    expect(api[0]).toBe('small');
    act(() => root.render(<Probe repo=" https://github.com/acme/web " />));
    expect(api[0]).toBe('small');
    act(() => root.render(<Probe repo="https://github.com/acme/api" />));
    expect(api[0]).toBeNull();
    // Back to the first one: the old pick doesn't come back either.
    act(() => root.render(<Probe repo="https://github.com/acme/web" />));
    expect(api[0]).toBeNull();
    act(() => api[1]('repo'));
    expect(api[0]).toBe('repo');
    act(() => root.unmount());
  });
});
