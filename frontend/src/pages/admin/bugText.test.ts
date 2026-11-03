import { describe, expect, it } from 'vitest';
import { eventText, filtersFromSearch, linkLabel, searchFromFilters, sessionHref } from './bugText';

describe('bug report page text', () => {
  it('describes each kind of triage change', () => {
    const e = { status: null, duplicateOfId: null, linkUrl: null, note: null };
    expect(eventText({ ...e, status: 'triaged' })).toBe('set triaged');
    expect(eventText({ ...e, status: 'duplicate', duplicateOfId: 'bug1' })).toBe('marked a duplicate of bug1');
    expect(eventText({ ...e, status: 'fixed', linkUrl: 'https://github.com/example-org/termag/pull/912' })).toBe('set fixed, linked https://github.com/example-org/termag/pull/912');
    expect(eventText({ ...e, linkUrl: '' })).toBe('cleared the link');
    expect(eventText({ ...e, note: 'repro on stage' })).toBe('noted: repro on stage');
  });

  it("links the reporter's session, ask threads by workstream", () => {
    expect(sessionHref({ projectId: 'p1', workstream: 'ask-abc' })).toBe('/chat/p/p1?ws=ask-abc');
    expect(sessionHref({ projectId: 'p1', workstream: 'main' })).toBe('/chat/p/p1');
    expect(sessionHref({ projectId: null, workstream: 'ask-abc' })).toBeNull();
  });

  it('labels GitHub links by number', () => {
    expect(linkLabel('https://github.com/example-org/termag/pull/912')).toBe('example-org/termag PR #912');
    expect(linkLabel('https://github.com/example-org/termag/issues/3')).toBe('example-org/termag #3');
  });

  it('round-trips the filters through the URL', () => {
    const f = { status: 'new', area: 'spaces', q: 'space put' };
    expect(searchFromFilters(f)).toBe('?status=new&area=spaces&q=space+put');
    expect(filtersFromSearch(new URLSearchParams(searchFromFilters(f)))).toEqual(f);
    expect(searchFromFilters({})).toBe('');
  });
});
