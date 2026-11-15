import { describe, expect, it } from 'vitest';
import { branchChip, sessionTitle, workstreamTitle } from './sessionTitle';
import { chatRowName } from './simpleChat';
import { orchestratorLead } from './OrchestratorToggle';
import type { Project, Workstream } from '../types';

const ws = (over: Partial<Workstream>): Workstream => ({ id: over.name ?? 'w', projectId: 'p', name: 'main', branch: 'main', archived: false, ...over } as Workstream);

describe('sessionTitle: one title per session', () => {
  it('takes a person\'s rename first, then the ask\'s title, then Claude\'s, then the names', () => {
    const base = { projectName: 'billing-api', workstream: 'fix-retries' };
    expect(sessionTitle({ ...base, sessionTitle: 'My rename', sessionTitleSource: 'person', askTitle: 'Ask title' })).toBe('My rename');
    expect(sessionTitle({ ...base, sessionTitle: 'Claude title', sessionTitleSource: 'claude', askTitle: 'Ask title' })).toBe('Ask title');
    expect(sessionTitle({ ...base, sessionTitle: 'Claude title', sessionTitleSource: 'claude' })).toBe('Claude title');
    expect(sessionTitle(base)).toBe('fix-retries');
    expect(sessionTitle({ projectName: 'billing-api', workstream: 'main' })).toBe('billing-api');
  });

  it('keeps a person\'s rename over Claude\'s title', () => {
    expect(sessionTitle({ projectName: 'p', workstream: 'main', sessionTitle: 'Renamed', sessionTitleSource: 'person' })).toBe('Renamed');
  });

  it('reads a title from before its source was kept as Claude\'s', () => {
    expect(sessionTitle({ projectName: 'p', workstream: 'main', sessionTitle: 'Old title', sessionTitleSource: null, askTitle: 'Ask' })).toBe('Ask');
    expect(sessionTitle({ projectName: 'p', workstream: 'main', sessionTitle: '  Old title ' })).toBe('Old title');
  });

  it('names an ask by its title, else by its thread id, never by Claude\'s title (#743)', () => {
    expect(sessionTitle({ projectName: 'p', workstream: 'ask-t1', askThreadId: 't1', askTitle: 'Review the vault client' })).toBe('Review the vault client');
    expect(sessionTitle({ projectName: 'p', workstream: 'ask-t1', askThreadId: 't1', askTitle: '  ', sessionTitle: 'Claude title' })).toBe('ask-t1');
    // A person's rename still wins.
    expect(sessionTitle({ projectName: 'p', workstream: 'ask-t1', askThreadId: 't1', sessionTitle: 'Mine', sessionTitleSource: 'person' })).toBe('Mine');
  });

  it('reads a project\'s workstream row', () => {
    const project = { name: 'billing-api' } as Project;
    expect(workstreamTitle(project, 'main', ws({ sessionTitle: 'Fix the login test', sessionTitleSource: 'claude' }))).toBe('Fix the login test');
    expect(workstreamTitle(project, 'ask-t9', ws({ name: 'ask-t9', askThread: { id: 't9', title: 'Triage CI' } }))).toBe('Triage CI');
    expect(workstreamTitle(project, 'feat', undefined)).toBe('feat');
  });
});

describe('chatRowName: the sidebar row leads with the title, never " · <workstream>"', () => {
  it('puts the project under a title that isn\'t its name, and nothing under the project\'s own', () => {
    expect(chatRowName({ projectName: 'billing-api', workstream: 'main', sessionTitle: 'Fix retries' })).toEqual({ title: 'Fix retries', where: 'billing-api', ask: false });
    expect(chatRowName({ projectName: 'billing-api', workstream: 'main' })).toEqual({ title: 'billing-api', where: null, ask: false });
    expect(chatRowName({ projectName: 'billing-api', workstream: 'feat' })).toEqual({ title: 'feat', where: 'billing-api', ask: false });
  });

  it('gives an ask its own session title as the second line when that says something else', () => {
    expect(chatRowName({ projectName: 'p', workstream: 'ask-t1', askThreadId: 't1', askTitle: 'Review', sessionTitle: 'Reviewing the client' }))
      .toEqual({ title: 'Review', where: 'Reviewing the client', ask: true });
    expect(chatRowName({ projectName: 'p', workstream: 'ask-t1', askThreadId: 't1' })).toEqual({ title: 'ask-t1', where: null, ask: true });
  });
});

describe('branchChip', () => {
  const project = (workstreams: Workstream[]) => ({ workstreams } as Pick<Project, 'workstreams'>);
  it('shows a session\'s branch only when it isn\'t the default (main\'s)', () => {
    const p = project([ws({ name: 'main', branch: 'trunk' }), ws({ name: 'fix', branch: 'fix/login' }), ws({ name: 'same', branch: 'trunk' })]);
    expect(branchChip(p, 'fix')).toBe('fix/login');
    expect(branchChip(p, 'same')).toBeNull();
    expect(branchChip(p, 'main')).toBeNull();
    expect(branchChip(p, 'missing')).toBeNull();
  });
});

describe('the orchestrator toggle', () => {
  it('says the setting reaches the sessions branched off this one', () => {
    expect(orchestratorLead(true, 'available')).toBe('On for this session, and for sessions you branch off it later');
    expect(orchestratorLead(false, 'available')).toBe('Act as an orchestrator');
  });
});
