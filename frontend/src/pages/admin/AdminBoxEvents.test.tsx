// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import type { BoxOperation } from '../../services/adminApi';
import { AdminBoxEvents, boxOperationLine } from './AdminBoxEvents';

const NOW = Date.parse('2026-10-28T12:00:00Z');
const op = (over: Partial<BoxOperation> = {}): BoxOperation => ({
  id: 'e1', kind: 'resize', actor: 'zane', actorRole: 'owner', reason: null, from: 'small', to: 'large', phase: 'done',
  running: false, startedAt: new Date(NOW - 3 * 60_000).toISOString(), finishedAt: new Date(NOW).toISOString(), error: null, ...over,
});

describe("the Fleet card's recent operations", () => {
  it('reads each operation in a line', () => {
    expect(boxOperationLine(op(), NOW)).toMatch(/^resize small → large by zane \(owner\) · done · 3m/);
    expect(boxOperationLine(op({ kind: 'disk-grow', from: '152 GB', to: '304 GB', actorRole: 'admin', actor: 'ada', running: true, phase: 'filesystem' }), NOW))
      .toMatch(/^disk-grow 152 GB → 304 GB by ada \(admin\) · filesystem…/);
  });

  it("lists them newest first, with an admin's reason and a failure's error", () => {
    const el = document.createElement('div');
    const root = createRoot(el);
    act(() => root.render(<AdminBoxEvents now={NOW} events={[
      op({ id: 'e2', actorRole: 'admin', actor: 'ada', reason: 'cost', phase: 'failed', error: 'no capacity' }), op(),
    ]} />));
    const items = [...el.querySelectorAll('li')];
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain('“cost”');
    expect(items[0].textContent).toContain('no capacity');
    expect(items[0].className).toBe('admin-bad');
    act(() => root.render(<AdminBoxEvents now={NOW} events={[]} />));
    expect(el.textContent).toBe('none recorded');
    act(() => root.unmount());
  });
});
