// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolItem } from '../../chat/toolRuns';
import { ReplyMeta, RunTime, ToolTime } from './ChatTimes';
import { ToolCard } from './ToolCards';

function bash(id: string, over: Partial<ToolItem> = {}): ToolItem {
  return { kind: 'tool', key: `tool:${id}`, id, name: 'Bash', input: { command: 'make', description: 'Build' }, inputJson: '', result: 'ok', isError: false, done: true, ...over };
}

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // Not Intl: the fake timers' own Intl would hide the viewer's zone below.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  // The viewer is in Los Angeles; it is 28 Oct 2026, 18:20 there.
  vi.setSystemTime(new Date('2026-10-29T01:20:00Z'));
  vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({ timeZone: 'America/Los_Angeles' } as Intl.ResolvedDateTimeFormatOptions);
  host = document.createElement('div');
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const render = (el: React.ReactElement) => act(() => root.render(el));
const time = (sel: string) => host.querySelector<HTMLElement>(`${sel} time`);

describe('ReplyMeta', () => {
  it('adds the end, local to the viewer, with the full stamp and zone on hover', () => {
    render(<ReplyMeta cost={{ costUsd: 0.14, durationMs: 9000, endedAt: '2026-10-29T01:14:05.120Z' }} />);
    expect(host.querySelector('.sdk-reply-meta')!.textContent).toBe('$0.14 · 9s · 18:14');
    expect(time('.sdk-reply-meta')!.dataset.tip).toBe('Ended 28 Oct 2026, 18:14:05 PDT');
    expect(time('.sdk-reply-meta')!.getAttribute('dateTime')).toBe('2026-10-29T01:14:05.120Z');
    expect(time('.sdk-reply-meta')!.tabIndex).toBe(0);
  });

  it('says the day for a reply from another day', () => {
    render(<ReplyMeta cost={{ costUsd: 0.14, durationMs: 9000, endedAt: '2026-10-27T16:00:00Z' }} />);
    expect(host.querySelector('.sdk-reply-meta')!.textContent).toBe('$0.14 · 9s · 27 Oct 09:00');
  });

  it('is as before without an end (an older record), and nothing with nothing known', () => {
    render(<ReplyMeta cost={{ costUsd: 0.14, durationMs: 9000 }} />);
    expect(host.querySelector('.sdk-reply-meta')!.textContent).toBe('$0.14 · 9s');
    expect(host.querySelector('time')).toBeNull();
    render(<ReplyMeta cost={{ costUsd: null, durationMs: null }} />);
    expect(host.querySelector('.sdk-reply-meta')).toBeNull();
  });
});

describe('ToolTime', () => {
  it('counts a running call live, ticking without a re-render from above', () => {
    render(<ToolCard item={bash('t1', { done: false, result: null, startedAt: '2026-10-29T01:19:48Z' })} />);
    const live = host.querySelector<HTMLElement>('.sdk-tool-time')!;
    expect(live.hasAttribute('data-live')).toBe(true);
    expect(live.textContent).toBe('running 12s');
    act(() => { vi.advanceTimersByTime(3000); });
    expect(host.querySelector('.sdk-tool-time')!.textContent).toBe('running 15s');
    act(() => { vi.advanceTimersByTime(12 * 60_000); });
    expect(host.querySelector('.sdk-tool-time')!.textContent).toBe('running 12m');
    expect(time('.sdk-tool-time')!.dataset.tip).toBe('Started 28 Oct 2026, 18:19:48 PDT');
  });

  it('sits inside the head row, so it takes no room of its own', () => {
    render(<ToolCard item={bash('t1', { done: false, result: null, startedAt: '2026-10-29T01:19:48Z' })} />);
    expect(host.querySelector('.sdk-tool-head .sdk-tool-time')).not.toBeNull();
  });

  it('shows a finished call’s duration and end, hover only (no data-live)', () => {
    render(<ToolTime item={bash('t1', { startedAt: '2026-10-29T01:02:11Z', endedAt: '2026-10-29T01:14:05Z' })} />);
    const el = host.querySelector<HTMLElement>('.sdk-tool-time')!;
    expect(el.hasAttribute('data-live')).toBe(false);
    expect(el.textContent).toBe('11m 54s · 18:14');
    expect(time('.sdk-tool-time')!.dataset.tip).toBe('Ended 28 Oct 2026, 18:14:05 PDT, after 11m 54s');
  });

  it('says "about" for a time taken from the nearest event, and shows only the end without a start', () => {
    render(<ToolTime item={bash('t1', { endedAt: '2026-10-29T01:14:05Z', endGuessed: true })} />);
    expect(host.querySelector('.sdk-tool-time')!.textContent).toBe('18:14');
    expect(time('.sdk-tool-time')!.dataset.tip).toBe('Ended about 28 Oct 2026, 18:14:05 PDT');
  });

  it('shows nothing for a call with no times at all', () => {
    render(<ToolTime item={bash('t1')} />);
    expect(host.innerHTML).toBe('');
    render(<ToolTime item={bash('t1', { done: false, result: null })} />);
    expect(host.innerHTML).toBe('');
  });

  it('counts a background call while its task runs, then shows only its start', () => {
    const start = '2026-10-29T01:15:00Z';
    render(<ToolTime item={bash('t1', { background: 'running', startedAt: start, endedAt: '2026-10-29T01:15:01Z' })} />);
    expect(host.querySelector('.sdk-tool-time')!.textContent).toBe('running 5m');
    render(<ToolTime item={bash('t1', { background: 'done', startedAt: start, endedAt: '2026-10-29T01:15:01Z' })} />);
    expect(host.querySelector('.sdk-tool-time')!.textContent).toBe('started 18:15');
  });
});

describe('RunTime', () => {
  it('shows a finished run’s span and total, the full span on hover', () => {
    render(<RunTime tools={[
      bash('a', { startedAt: '2026-10-29T01:02:11Z', endedAt: '2026-10-29T01:05:00Z' }),
      bash('b', { startedAt: '2026-10-29T01:05:01Z', endedAt: '2026-10-29T01:14:05Z' }),
    ]} />);
    expect(host.querySelector('.sdk-run-time')!.textContent).toBe('18:02–18:14 · 11m 54s');
    expect(time('.sdk-run-time')!.dataset.tip).toBe('28 Oct 2026, 18:02:11 – 18:14:05 PDT, 11m 54s in all');
  });

  it('claims no end for a run with a call sent to the background: its endedAt is when it was sent, not when its task ended (Bugbot #893)', () => {
    render(<RunTime tools={[
      bash('a', { startedAt: '2026-10-29T01:02:11Z', endedAt: '2026-10-29T01:02:12Z', background: 'done' }),
      bash('b', { startedAt: '2026-10-29T01:02:13Z', endedAt: '2026-10-29T01:02:20Z' }),
    ]} />);
    expect(host.querySelector('.sdk-run-time')!.textContent).toBe('started 18:02');
    expect(time('.sdk-run-time')!.dataset.tip).toBe('Started 28 Oct 2026, 18:02:11 PDT');
  });

  it('says since when for a run still going, and nothing for a run with no times', () => {
    render(<RunTime tools={[bash('a', { startedAt: '2026-10-29T01:02:11Z', endedAt: '2026-10-29T01:05:00Z' }), bash('b', { done: false, result: null })]} />);
    expect(host.querySelector('.sdk-run-time')!.textContent).toBe('since 18:02');
    render(<RunTime tools={[bash('a'), bash('b')]} />);
    expect(host.innerHTML).toBe('');
  });
});
