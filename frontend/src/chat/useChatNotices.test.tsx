// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chatApi } from '../services/api';
import { NOTICE_RECHECK_MS, useChatNotices } from './useChatNotices';

vi.mock('../services/api', () => ({ chatApi: { notices: vi.fn() } }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const line = '[termag] Claude Code was updated to 2.1.320 (automatic nightly run); resuming your session.';
const row = { id: 'n1', kind: 'tool-update', pane: 'agent', text: line, at: '2026-11-04T03:12:00.000Z' };
let root: Root | null = null;
let seen: string[] = [];
function Probe({ k }: { k: string }) {
  seen = useChatNotices('p1', 'main', k).map(n => n.id);
  return null;
}
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });
afterEach(() => { act(() => root?.unmount()); root = null; vi.useRealTimers(); });

describe('useChatNotices', () => {
  it('reads again shortly after a status change, so a line stored just after it still shows', async () => {
    vi.useFakeTimers();
    // The status moved before the server had stored the line: the first read has none.
    vi.mocked(chatApi.notices).mockResolvedValueOnce({ notices: [] }).mockResolvedValue({ notices: [row, { ...row, id: 'bad', text: "[termag] it's" }] });
    root = createRoot(document.createElement('div'));
    act(() => root!.render(<Probe k="working" />));
    await flush();
    expect(seen).toEqual([]);
    await act(async () => { vi.advanceTimersByTime(NOTICE_RECHECK_MS); });
    await flush();
    expect(seen).toEqual(['n1']);
    expect(chatApi.notices).toHaveBeenCalledWith('p1', 'main');
  });
});
