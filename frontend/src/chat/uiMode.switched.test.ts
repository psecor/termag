// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const recorded: Array<{ name: string; attributes: unknown }> = [];
vi.mock('../observability', () => ({
  recordProductEvent: (name: string, attributes: unknown) => { recorded.push({ name, attributes }); },
}));

const { adoptUiMode, recordUiMode } = await import('./uiMode');

beforeEach(() => {
  recorded.length = 0;
  window.localStorage.clear();
});

describe('ui.mode.switched', () => {
  it('is recorded when a visit moves between the simple UI and the workspace', () => {
    recordUiMode('full');
    recordUiMode('simple');
    recordUiMode('simple');
    recordUiMode('full');
    expect(recorded).toEqual([
      { name: 'ui.mode.switched', attributes: { 'termag.from': 'full', 'termag.to': 'simple' } },
      { name: 'ui.mode.switched', attributes: { 'termag.from': 'simple', 'termag.to': 'full' } },
    ]);
  });

  it('is not recorded on a browser\'s first visit, which has nothing to move from', () => {
    recordUiMode('simple');
    expect(recorded).toEqual([]);
  });

  it('is not recorded when the browser adopts the choice kept on the user', () => {
    adoptUiMode('simple');
    expect(recorded).toEqual([]);
  });
});
