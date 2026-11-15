import { describe, expect, it } from 'vitest';
import { agentText, emptyText, feedbackFiltersFromSearch, truncatedText, whereFrom } from './feedbackText';

describe('feedback text', () => {
  it('says where it came from: box, project, and the session when it is not main', () => {
    expect(whereFrom({ box: 'ana-box', project: 'termag', workstream: 'main', threadId: null, credential: 'box' })).toBe('ana-box · termag');
    expect(whereFrom({ box: 'ana-box', project: 'termag', workstream: 'ask-cmx1', threadId: 'cmx1', credential: 'box' })).toBe('ana-box · termag (ask thread cmx1)');
    expect(whereFrom({ box: null, project: 'termag', workstream: 'fix-x', threadId: null, credential: 'device' })).toBe('termag (fix-x)');
    expect(whereFrom({ box: null, project: null, workstream: null, threadId: null, credential: 'device' })).toBe('a sign-in, no box');
  });

  it('names the agent with what is known', () => {
    expect(agentText({ agentProvider: 'claude', agentModel: 'opus', cliVersion: '0.4.1' })).toBe('claude · opus · CLI 0.4.1');
    expect(agentText({ agentProvider: null, agentModel: null, cliVersion: null })).toBe('');
  });

  it('reads only filters the API takes from the URL', () => {
    expect(feedbackFiltersFromSearch(new URLSearchParams('status=new&kind=idea'))).toEqual({ status: 'new', kind: 'idea' });
    expect(feedbackFiltersFromSearch(new URLSearchParams('status=fixed&kind=rant'))).toEqual({});
    expect(emptyText({})).toMatch(/termag feedback/);
    expect(emptyText({ kind: 'idea' })).toBe('no feedback matches');
  });

  it('says when the list stopped at the newest 500, and how to reach older feedback', () => {
    expect(truncatedText(false, { status: 'new' })).toBeNull();
    expect(truncatedText(undefined, {})).toBeNull();
    expect(truncatedText(true, { status: 'new' })).toBe('Showing the newest 500 only: mark these seen, or pick a kind, to bring older new feedback into the list.');
    expect(truncatedText(true, {})).toBe('Showing the newest 500 only: pick a status or a kind to reach older feedback.');
    expect(truncatedText(true, { status: 'seen', kind: 'idea' })).toBe('Showing the newest 500 only: older feedback is not listed.');
  });
});
