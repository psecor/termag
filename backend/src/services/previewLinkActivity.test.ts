import { describe, expect, it, vi } from 'vitest';

const noteBoxActivity = vi.fn();
vi.mock('./boxActivity', () => ({ noteBoxActivity: (...a: unknown[]) => noteBoxActivity(...a) }));
const { isViewerInput, notePreviewViewerActivity } = await import('./previewLinkActivity');

describe('preview link viewer activity (the preview-share rule)', () => {
  it('counts a top-level navigation and a user-activated request', () => {
    expect(isViewerInput({ 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' })).toBe(true);
    expect(isViewerInput({ 'sec-fetch-mode': 'cors', 'sec-fetch-user': '?1' })).toBe(true);
  });

  it("never counts what a background tab does: subresources, fetches, polling, WebSocket upgrades", () => {
    expect(isViewerInput({ 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'script' })).toBe(false);
    expect(isViewerInput({ 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' })).toBe(false);
    expect(isViewerInput({ 'sec-fetch-mode': 'websocket', upgrade: 'websocket' })).toBe(false);
    expect(isViewerInput({})).toBe(false);
  });

  it('moves the box clock only for input', () => {
    expect(notePreviewViewerActivity('box-1', { 'sec-fetch-mode': 'cors' }, 5)).toBe(false);
    expect(noteBoxActivity).not.toHaveBeenCalled();
    expect(notePreviewViewerActivity('box-1', { 'sec-fetch-mode': ['navigate'] }, 5)).toBe(true);
    expect(noteBoxActivity).toHaveBeenCalledWith('box-1', 5);
  });
});
