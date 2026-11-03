// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../launchpad/sprite', () => ({ ensureLaunchPadSprite: () => Promise.resolve() }));
const { default: GenUiSurface } = await import('../GenUiSurface');
const { default: Timeline } = await import('./Timeline');

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

function draw(props: object) {
  const text = JSON.stringify({ root: 't', elements: { t: { type: 'Timeline', props, children: [] } } });
  act(() => root.render(<GenUiSurface block={{ type: 'code', lang: 'spec', text, open: false }} itemKey="r" streaming={false} chat={null} fallback={null} />));
}

const event = (id: string, extra: object = {}) => ({ id, time: 'Oct 27, 4:09 PM', title: `Event ${id}`, ...extra });

describe('Timeline', () => {
  it('takes 1 to 50 events, each with an id, a time and a title', () => {
    expect(Timeline.props.safeParse({ events: [event('a', { detail: 'More', tone: 'danger' })] }).success).toBe(true);
    expect(Timeline.props.safeParse({ events: [] }).success).toBe(false);
    expect(Timeline.props.safeParse({ events: Array.from({ length: 51 }, (_, i) => event(String(i))) }).success).toBe(false);
    expect(Timeline.props.safeParse({ events: [{ id: 'a', title: 'No time' }] }).success).toBe(false);
    expect(Timeline.props.safeParse({ events: [event('a', { tone: 'running' })] }).success).toBe(false);
    expect(Timeline.props.safeParse({ events: [event('a', { time: 'x'.repeat(61) })] }).success).toBe(false);
  });

  it('draws the events in the order given, each tone said in words as well as colour', () => {
    draw({ events: [event('3', { tone: 'success', detail: 'All checks green.' }), event('2'), event('1', { tone: 'danger' })] });
    expect(host.querySelector('.genui-bad')).toBeNull();
    const items = [...host.querySelectorAll('ol.genui-timeline > li')];
    expect(items.map(li => li.getAttribute('data-tone'))).toEqual(['success', 'default', 'danger']);
    expect(items.map(li => li.querySelector('.genui-timeline-title')?.textContent)).toEqual(['Event 3 (success)', 'Event 2', 'Event 1 (problem)']);
    expect(items[0].querySelector('.genui-timeline-time')?.textContent).toBe('Oct 27, 4:09 PM');
    expect(items[0].querySelector('.genui-timeline-detail')?.textContent).toBe('All checks green.');
    expect(items[1].querySelector('.genui-timeline-detail')).toBeNull();
    expect(items.every(li => li.querySelector('.genui-timeline-dot')?.getAttribute('aria-hidden') === 'true')).toBe(true);
  });

  it('draws every event when two share an id', () => {
    draw({ events: [event('a'), event('a')] });
    expect(host.querySelectorAll('ol.genui-timeline > li')).toHaveLength(2);
  });
});
