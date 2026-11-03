// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ContextRing } from './ContextRing';
import { emptyUsage, type ChatUsage } from './contextUsage';

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const now = () => new Date(2026, 9, 23, 14, 0).getTime();
const render = (usage: ChatUsage, costUsd: number | null = null) => act(() => root.render(<ContextRing usage={usage} costUsd={costUsd} now={now} />));
const button = () => host.querySelector('button.chat-ring-btn') as HTMLButtonElement;
const pop = () => host.querySelector('.chat-ring-pop');
const arc = (kind: string) => host.querySelector(`.chat-ring-arc[data-kind="${kind}"]`);
const track = (kind: string) => host.querySelector(`.chat-ring-track[data-kind="${kind}"]`);
const meters = (kind: string) => [...host.querySelectorAll(`.chat-ring-meter[data-kind="${kind}"]`)];

describe('ContextRing', () => {
  it('is an empty track until Claude reports usage', () => {
    render(emptyUsage);
    expect(button().getAttribute('aria-label')).toBe('Context usage not known yet');
    // The arc is mounted at zero, faded out, so it can wind down and up.
    expect(arc('context')?.hasAttribute('data-empty')).toBe(true);
    act(() => button().click());
    expect(pop()?.textContent).toContain("Fills in with Claude's next reply");
  });

  it('fills with the context, and hovering shows the numbers and the cost', () => {
    render({ ...emptyUsage, contextTokens: 84_206, model: 'claude-opus-5-5', contextWindow: 200_000 }, 0.42);
    expect(button().getAttribute('aria-label')).toBe('Context 42% used');
    expect(arc('context')?.getAttribute('data-tone')).toBe('ok');
    // No plan usage reported, so no inner ring.
    expect(track('plan')).toBeNull();
    expect(pop()).toBeNull();
    act(() => { host.querySelector('.chat-ring')!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); });
    expect(pop()?.textContent).toContain('84.2k of 200k tokens · 42%');
    expect(pop()?.textContent).toContain('This chat$0.42');
    expect(pop()?.textContent).not.toContain('Plan usage');
  });

  it('shows the plan windows in an inner ring of their own, which turns with the fullest', () => {
    render({
      ...emptyUsage, contextTokens: 40_000,
      limits: {
        seven_day: { utilization: 0.93, resetsAt: new Date(2026, 9, 26, 9, 0).getTime(), status: 'allowed_warning' },
        five_hour: { utilization: 0.23, resetsAt: new Date(2026, 9, 23, 18, 40).getTime(), status: 'allowed' },
      },
    });
    expect(arc('context')?.getAttribute('data-tone')).toBe('ok');
    expect(arc('plan')?.getAttribute('data-tone')).toBe('danger');
    act(() => button().click());
    // The bars take their ring's colour: one for the context, one per window for the plan.
    expect(meters('context')).toHaveLength(1);
    expect(meters('plan').map(m => m.getAttribute('data-tone'))).toEqual(['ok', 'danger']);
    const text = pop()?.textContent ?? '';
    expect(text).toContain('Plan usage');
    expect(text.indexOf('5-hour window')).toBeLessThan(text.indexOf('7-day window'));
    expect(text).toContain('23%');
    expect(text).toContain('93%');
    expect(text).toMatch(/resets 6:40\sPM/);
  });

  it("shows no plan usage for an Enterprise seat's extra-usage window, until it nears its limit", () => {
    const overage = { utilization: null, resetsAt: new Date(2026, 10, 1, 0, 0).getTime(), status: 'allowed' };
    render({ ...emptyUsage, contextTokens: 84_206, model: 'claude-opus-5-5', limits: { overage } });
    act(() => button().click());
    expect(pop()?.textContent).toContain('84.2k of 1M tokens · 8%');
    expect(pop()?.textContent).not.toContain('Plan usage');
    expect(track('plan')).toBeNull();
    render({ ...emptyUsage, contextTokens: 84_206, model: 'claude-opus-5-5', limits: { overage: { ...overage, status: 'allowed_warning' } } });
    // Nothing to fill, so the inner ring's track says it instead.
    expect(arc('plan')?.hasAttribute('data-empty')).toBe(true);
    expect(track('plan')?.getAttribute('data-tone')).toBe('warn');
    expect(pop()?.textContent).toContain('Extra usageClose to the limit');
  });

  it("shows a seat's monthly spend with its amounts and reset", () => {
    render({
      ...emptyUsage, contextTokens: 84_206, model: 'claude-opus-5-5',
      limits: {
        overage: { utilization: null, resetsAt: new Date(2026, 10, 1, 0, 0).getTime(), status: 'allowed' },
        monthly_spend: { utilization: 0.1169, resetsAt: new Date(2026, 10, 1, 0, 0).getTime(), status: 'allowed', detail: '$818 of $7,000' },
      },
    });
    act(() => button().click());
    const text = pop()?.textContent ?? '';
    expect(text).toContain('Plan usage');
    expect(text).toContain('Monthly spend12%');
    expect(text).toMatch(/\$818 of \$7,000 · resets/);
    expect(text).not.toContain('Extra usage');
  });

  it('says a rejected window has hit its limit', () => {
    render({ ...emptyUsage, limits: { five_hour: { utilization: 1, resetsAt: null, status: 'rejected' } } });
    act(() => button().click());
    expect(pop()?.textContent).toContain('Limit reached');
  });

  it('pins on click, and Escape or a click elsewhere closes it', () => {
    render({ ...emptyUsage, contextTokens: 10_000 });
    act(() => button().click());
    expect(button().getAttribute('aria-expanded')).toBe('true');
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
    expect(pop()).toBeNull();
    act(() => button().click());
    act(() => { document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })); });
    expect(pop()).toBeNull();
  });

  // SdkChatView's Escape-to-stop stands down while any [role="dialog"] is open and when Escape was taken.
  const escape = () => {
    const e = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    act(() => { document.dispatchEvent(e); });
    return e;
  };

  it("is not a dialog, so a hover peek leaves a running turn's Escape-to-stop alone", () => {
    render({ ...emptyUsage, contextTokens: 10_000 });
    act(() => { host.querySelector('.chat-ring')!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); });
    expect(pop()).not.toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    const e = escape();
    expect(e.defaultPrevented).toBe(false);
    expect(pop()).toBeNull();
  });

  it('takes the Escape that closes a pinned or keyboard-opened popover', () => {
    render({ ...emptyUsage, contextTokens: 10_000 });
    act(() => button().click());
    expect(escape().defaultPrevented).toBe(true);
    expect(pop()).toBeNull();
    act(() => button().focus());
    expect(pop()).not.toBeNull();
    expect(escape().defaultPrevented).toBe(true);
    expect(pop()).toBeNull();
  });
});

describe('ContextRing: Compact, Clear and Resume', () => {
  const usage = { ...emptyUsage, contextTokens: 40_800, contextWindow: 1_000_000 };
  const ready = { enabled: true, reason: null };
  type Controls = NonNullable<React.ComponentProps<typeof ContextRing>['actions']>;
  const renderActions = (actions: Controls | null, extra: Partial<React.ComponentProps<typeof ContextRing>> = {}) =>
    act(() => root.render(<ContextRing usage={usage} costUsd={0.25} actions={actions} now={now} {...extra} />));
  const btn = (cls: string) => host.querySelector(`.${cls}`) as HTMLButtonElement | null;

  it('is not there when the session does not offer it', () => {
    renderActions(null);
    act(() => button().click());
    expect(host.querySelector('.chat-ring-actions')).toBeNull();
  });

  it('runs each action on its first click, with no confirm', () => {
    const ran: string[] = [];
    renderActions({ clear: ready, compact: ready, resume: false, onAction: a => ran.push(a) });
    act(() => { host.querySelector('.chat-ring')!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); });
    act(() => btn('chat-ring-compact')!.click());
    act(() => btn('chat-ring-clear')!.click());
    expect(ran).toEqual(['compact', 'clear']);
    expect(btn('chat-ring-resume')).toBeNull();
  });

  it('offers Resume previous context after a clear', () => {
    const ran: string[] = [];
    renderActions({ clear: { enabled: false, reason: 'Context is already clear.' }, compact: { enabled: false, reason: 'Nothing to compact yet.' }, resume: true, onAction: a => ran.push(a) });
    act(() => button().click());
    act(() => btn('chat-ring-resume')!.click());
    expect(ran).toEqual(['resume']);
    expect(btn('chat-ring-clear')!.title).toBe('Context is already clear.');
  });

  it('is short labels on the app\'s small buttons, the explanation and any reason in the tooltip, no text beside them', () => {
    const why = { enabled: false, reason: 'Wait for Claude to finish, or stop it, first.' };
    renderActions({ clear: ready, compact: why, resume: false, onAction: () => {} });
    act(() => button().click());
    const buttons = [...host.querySelectorAll('.chat-ring-actions button')] as HTMLButtonElement[];
    expect(buttons.map(b => b.textContent)).toEqual(['Compact', 'Clear']);
    expect(buttons.every(b => b.className.split(' ')[0] === 'btn-tiny')).toBe(true);
    expect(btn('chat-ring-compact')!.disabled).toBe(true);
    expect(btn('chat-ring-compact')!.title).toBe(why.reason);
    expect(btn('chat-ring-clear')!.title).toMatch(/empty context/);
    expect(host.querySelector('.chat-ring-actions')!.textContent).toBe('CompactClear');
  });

  it('keeps one layout: the meter is there before Claude reports, and a compaction says one line', () => {
    renderActions(null, { usage: { ...emptyUsage }, compactedFrom: 163_152 });
    act(() => button().click());
    expect(host.querySelector('.chat-ring-sub')!.textContent).toBe('Compacted from 163k tokens');
    expect(meters('context')).toHaveLength(1);
  });

  it('keeps its labels while an action is on its way, and disables the row', () => {
    renderActions({ clear: ready, compact: ready, resume: false, busy: 'compact', onAction: () => {} });
    act(() => button().click());
    expect(btn('chat-ring-compact')!.textContent).toBe('Compact');
    expect(btn('chat-ring-clear')!.disabled).toBe(true);
    expect(host.querySelector('.chat-ring-actions')!.getAttribute('aria-busy')).toBe('true');
  });

  it('keeps the arc mounted at zero, faded, so a clear winds it down', () => {
    renderActions(null, { usage: { ...emptyUsage } });
    expect(arc('context')?.hasAttribute('data-empty')).toBe(true);
    renderActions(null);
    expect(arc('context')?.hasAttribute('data-empty')).toBe(false);
  });
});

describe('ContextRing: cost rows', () => {
  it('shows the chat total, and a smaller since-cleared figure only after a clear', () => {
    act(() => root.render(<ContextRing usage={emptyUsage} costUsd={0.5} now={now} />));
    act(() => button().click());
    expect(pop()?.textContent).toContain('This chat$0.50');
    expect(pop()?.textContent).not.toContain('Since cleared');
    act(() => root.render(<ContextRing usage={emptyUsage} costUsd={0.5} sinceClearedUsd={0.1} now={now} />));
    // The same row, so the popover does not grow on a clear.
    expect(host.querySelectorAll('.chat-ring-row')).toHaveLength(1);
    expect(host.querySelector('.chat-ring-row')?.textContent).toBe('This chat · $0.10 since cleared$0.50');
  });
});

describe('ContextRing: every row stays one line (Bugbot #738)', () => {
  it('gives the cost label its full text as a tooltip, for when the popover cuts it short', () => {
    act(() => root.render(<ContextRing usage={emptyUsage} costUsd={1234.56} sinceClearedUsd={123.45} now={now} />));
    act(() => button().click());
    const label = host.querySelector('.chat-ring-row .chat-ring-row-label') as HTMLElement | null;
    expect(label?.textContent).toBe('This chat · $123.45 since cleared');
    expect(label?.title).toBe('This chat · $123.45 since cleared');
    expect(host.querySelector('.chat-ring-row b')?.textContent).toBe('$1234.56');
  });
});

describe('ContextRing: two looks only, enabled or disabled (review on #738)', () => {
  const ready = { enabled: true, reason: null };
  const renderActions = (actions: React.ComponentProps<typeof ContextRing>['actions']) =>
    act(() => root.render(<ContextRing usage={{ ...emptyUsage, contextTokens: 40_000 }} costUsd={0.25} actions={actions} now={now} />));
  const labels = () => [...host.querySelectorAll('.chat-ring-actions button')].map(b => b.textContent);

  it('puts Resume last, so Compact and Clear never move when it comes or goes', () => {
    renderActions({ clear: ready, compact: ready, resume: true, onAction: () => {} });
    act(() => button().click());
    expect(labels()).toEqual(['Compact', 'Clear', 'Resume']);
  });

  it('hides Resume while another action is on its way, instead of a disabled Resume', () => {
    renderActions({ clear: ready, compact: ready, resume: true, busy: 'clear', onAction: () => {} });
    act(() => button().click());
    expect(labels()).toEqual(['Compact', 'Clear']);
  });

  it('hides an action the chat can never do', () => {
    renderActions({ clear: ready, compact: null, resume: false, onAction: () => {} });
    act(() => button().click());
    expect(labels()).toEqual(['Clear']);
    renderActions({ clear: null, compact: null, resume: false, onAction: () => {} });
    expect(host.querySelector('.chat-ring-actions')).toBeNull();
  });
});
