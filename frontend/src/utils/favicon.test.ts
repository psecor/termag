/// <reference types="vite/client" />
import { describe, it, expect } from 'vitest';
import publicFavicon from '../../public/favicon.svg?raw';
import type { AgentStatus, Project, StatusMap } from '../types';
import { faviconHref, faviconState, faviconSvg, type FaviconState } from './favicon';

const USER = 'alice';

function project(name: string, over: Partial<Project> = {}): Project {
  return {
    id: name,
    name,
    archived: false,
    instanceId: null,
    workflows: [{ id: `${name}-a`, type: 'agent', server: 'local', projectId: name }],
    workstreams: [],
    ...over,
  } as Project;
}

const st = (status: AgentStatus['status'], over: Partial<AgentStatus> = {}): AgentStatus =>
  ({ status, updatedAt: '2026-01-01T00:00:00Z', ...over });

const state = (projects: Project[], statusMap: StatusMap, offline = false) =>
  faviconState({ projects, statusMap, username: USER, offline });

describe('faviconState', () => {
  it('is quiet with no projects', () => {
    expect(state([], {})).toBe('quiet');
  });

  it('is quiet when every session is idle or missing', () => {
    expect(state([project('a'), project('b')], { '|alice-a-agent': st('idle') })).toBe('quiet');
  });

  it('is working when a session is working', () => {
    expect(state([project('a')], { '|alice-a-agent': st('working') })).toBe('working');
  });

  it('is attention when a session is waiting', () => {
    expect(state([project('a')], { '|alice-a-agent': st('waiting') })).toBe('attention');
  });

  it('prefers attention over working across projects', () => {
    expect(state([project('a'), project('b')], {
      '|alice-a-agent': st('working'),
      '|alice-b-agent': st('waiting'),
    })).toBe('attention');
  });

  it('is stale when offline, even with a waiting session', () => {
    expect(state([project('a')], { '|alice-a-agent': st('waiting') }, true)).toBe('stale');
  });

  it('is attention when a working session is rate limited', () => {
    expect(state([project('a')], { '|alice-a-agent': st('working', { rateLimited: 'claude' }) })).toBe('attention');
  });

  it("ignores a collaborator's project", () => {
    const shared = project('a', { role: 'collaborator', ownerUsername: 'bob' });
    expect(state([shared], { '|bob-a-agent': st('waiting') })).toBe('quiet');
  });

  it('counts a project the user owns when role is owner', () => {
    expect(state([project('a', { role: 'owner' })], { '|alice-a-agent': st('waiting') })).toBe('attention');
  });

  it('ignores a project with no agent workflow', () => {
    const noAgent = project('a', { workflows: [{ id: 'x', type: 'data', server: 'local', projectId: 'a' }] });
    expect(state([noAgent], { '|alice-a-agent': st('waiting') })).toBe('quiet');
  });

  it('resolves a non-main workstream to the 4-segment session name', () => {
    const ws = (name: string) => ({ id: name, projectId: 'a', name, branch: name, archived: false, lastActiveAt: '', createdAt: '', updatedAt: '' });
    const p = project('a', { workstreams: [ws('main'), ws('feat')] });
    expect(state([p], { '|alice-a-feat-agent': st('waiting') })).toBe('attention');
    expect(state([p], { '|alice-a-agent': st('working') })).toBe('working');
  });

  it('keys a box project by its instance id, and ignores the same session on another instance', () => {
    const p = project('a', { instanceId: 'box-1' });
    expect(state([p], { 'box-1|alice-a-agent': st('waiting') })).toBe('attention');
    expect(state([p], { 'box-2|alice-a-agent': st('waiting') })).toBe('quiet');
    expect(state([p], { '|alice-a-agent': st('waiting') })).toBe('quiet');
  });
});

const STATES: FaviconState[] = ['attention', 'working', 'quiet', 'stale'];
const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();

describe('faviconSvg', () => {
  it('renders the quiet state identical to public/favicon.svg', () => {
    expect(collapse(faviconSvg('quiet'))).toBe(collapse(publicFavicon));
  });

  it('renders a distinct icon per state', () => {
    expect(new Set(STATES.map(faviconSvg)).size).toBe(STATES.length);
  });
});

describe('faviconHref', () => {
  it.each(STATES)('encodes the %s svg as a data url', s => {
    const href = faviconHref(s);
    expect(href.startsWith('data:image/svg+xml,')).toBe(true);
    expect(decodeURIComponent(href.slice('data:image/svg+xml,'.length))).toBe(faviconSvg(s));
  });
});
