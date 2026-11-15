// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeedbackItem } from '../../services/adminApi';

// The feedback list (AdminFeedback.tsx): each row's time,
// who, where from, the text and its kind; the filters go to the API from the
// URL; Mark seen calls the API and refreshes.
vi.mock('../../launchpad/sprite', () => ({ ensureLaunchPadSprite: () => Promise.resolve() }));
const NOW = Date.parse('2026-11-13T12:00:00Z');
const item = (over: Partial<FeedbackItem>): FeedbackItem => ({
  id: 'fb1', body: 'The sidebar is confusing: I never find my asks', kind: 'problem', status: 'new', createdAt: new Date(NOW - 5 * 60_000).toISOString(),
  seenAt: null, seenBy: null, reporter: 'ana@example.com', reporterUserId: 'u1', credential: 'box',
  box: 'ana-box', boxId: 'i-1', project: 'termag', projectId: 'p-1', workstream: 'main', threadId: null,
  agentProvider: 'claude', agentModel: 'claude-opus-5-5', agentVersion: 'claude-code 2.1.3', cliVersion: '0.4.1', boxAgentCommit: null, redacted: [],
  ...over,
});
const api = vi.hoisted(() => ({
  feedback: vi.fn(),
  feedbackCounts: vi.fn(async () => ({ counts: { new: 1, seen: 1 } })),
  setFeedbackStatus: vi.fn(async () => ({})),
}));
vi.mock('../../services/adminApi', async (orig) => ({ ...(await orig<typeof import('../../services/adminApi')>()), adminApi: api }));

import { AdminFeedback, FeedbackBadge } from './AdminFeedback';

let root: Root;
let el: HTMLDivElement;

async function mount(path: string) {
  await act(async () => root.render(
    <MemoryRouter initialEntries={[path]}>
      <nav><FeedbackBadge /></nav>
      <Routes><Route path="/admin/feedback" element={<AdminFeedback now={NOW} />} /></Routes>
    </MemoryRouter>,
  ));
}

beforeEach(() => {
  api.feedback.mockImplementation(async () => ({ feedback: [
    item({}),
    item({ id: 'fb2', body: 'Spaces are great', kind: 'praise', status: 'seen', seenBy: 'root@example.com', workstream: 'ask-cmx1', threadId: 'cmx1' }),
  ] }));
  api.setFeedbackStatus.mockClear();
  api.feedbackCounts.mockImplementation(async () => ({ counts: { new: 1, seen: 1 } }));
  api.feedback.mockClear();
  el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
});
afterEach(() => { act(() => root.unmount()); el.remove(); });

const rowTexts = () => [...el.querySelectorAll('tbody tr')].map(tr => tr.textContent ?? '');

describe('the feedback list', () => {
  it('shows each piece with when, status, kind, the text, who, where from and the agent', async () => {
    await mount('/admin/feedback');
    const [first, second] = rowTexts();
    expect(first).toContain('5m ago');
    expect(first).toContain('new');
    expect(first).toContain('problem');
    expect(first).toContain('The sidebar is confusing: I never find my asks');
    expect(first).toContain('ana@example.com');
    expect(first).toContain('ana-box · termag');
    expect(first).toContain('claude · claude-opus-5-5 · CLI 0.4.1');
    expect(first).toContain('Mark seen');
    expect(second).toContain('ana-box · termag (ask thread cmx1)');
    expect(second).toContain('Mark new');
    const where = [...el.querySelectorAll('tbody a')].map(a => a.getAttribute('href'));
    expect(where).toEqual(['/chat/p/p-1', '/chat/p/p-1?ws=ask-cmx1']);
    expect(el.textContent).toContain('1 new · 1 seen');
  });

  it('asks the API for the URL\'s filters, ignoring ones it would refuse', async () => {
    await mount('/admin/feedback?status=new&kind=idea');
    expect(api.feedback).toHaveBeenLastCalledWith({ status: 'new', kind: 'idea' });
    act(() => root.unmount());
    root = createRoot(el);
    await mount('/admin/feedback?status=fixed');
    expect(api.feedback).toHaveBeenLastCalledWith({});
  });

  it('marks a piece seen and fetches the list again', async () => {
    await mount('/admin/feedback');
    const calls = api.feedback.mock.calls.length;
    const button = [...el.querySelectorAll('button')].find(b => b.textContent === 'Mark seen')!;
    await act(async () => { button.click(); });
    expect(api.setFeedbackStatus).toHaveBeenCalledWith('fb1', 'seen');
    expect(api.feedback.mock.calls.length).toBeGreaterThan(calls);
  });

  it('updates the nav badge as soon as a piece is marked seen, not on its next poll', async () => {
    let fresh = 2;
    api.feedbackCounts.mockImplementation(async () => ({ counts: { new: fresh, seen: 0 } }));
    await mount('/admin/feedback');
    expect(el.querySelector('nav .admin-badge')?.textContent).toBe('2');
    fresh = 1;
    const button = [...el.querySelectorAll('button')].find(b => b.textContent === 'Mark seen')!;
    await act(async () => { button.click(); });
    await act(async () => { await Promise.resolve(); });
    expect(el.querySelector('nav .admin-badge')?.textContent).toBe('1');
  });

  it("leaves the action buttons' words out of the table search", async () => {
    api.feedback.mockImplementation(async () => ({ feedback: Array.from({ length: 30 }, (_, i) => item({ id: `fb${i}`, body: i === 0 ? 'the sidebar' : `remark ${i}` })) }));
    await mount('/admin/feedback');
    const search = el.querySelector('input[type="search"], input[aria-label*="earch"]') as HTMLInputElement;
    expect(search).not.toBeNull();
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    // Every row is new, so "seen" is only in the action button ("Mark seen").
    await act(async () => { setValue.call(search, 'seen'); search.dispatchEvent(new Event('input', { bubbles: true })); });
    expect(rowTexts().filter(t => t.includes('remark'))).toEqual([]);
    await act(async () => { setValue.call(search, 'sidebar'); search.dispatchEvent(new Event('input', { bubbles: true })); });
    expect(rowTexts()).toHaveLength(1);
  });

  it('says when the route stopped at the newest 500, so older new feedback is not silently missing', async () => {
    api.feedback.mockImplementation(async () => ({ feedback: Array.from({ length: 500 }, (_, i) => item({ id: `fb${i}` })), more: true }));
    await mount('/admin/feedback?status=new');
    expect(document.querySelector('.admin-feedback-truncated')?.textContent).toMatch(/newest 500 only: mark these seen/);
  });

  it('says nothing about a limit when exactly 500 match, or the whole list is shown', async () => {
    api.feedback.mockImplementation(async () => ({ feedback: Array.from({ length: 500 }, (_, i) => item({ id: `fb${i}` })), more: false }));
    await mount('/admin/feedback?status=new');
    expect(document.querySelector('.admin-feedback-truncated')).toBeNull();
  });

  it('says how to get feedback when there is none', async () => {
    api.feedback.mockImplementation(async () => ({ feedback: [] }));
    await mount('/admin/feedback');
    expect(el.textContent).toContain('no feedback yet: agents log it with `termag feedback`');
  });
});
