import { describe, expect, it } from 'vitest';
import type { Project } from '../types';
import { agentLabel, explorerAgents, type AgentNode } from './explorerAgents';
import { noSpaceAgents } from './noSpaceAgents';
import { chatListRows } from './simpleChat';
import type { InboxRow } from '../mobile/inbox';

// The person's explorer (#884): one session (orch/main) sent asks to projects
// all named termag-3, each on a box of its own made without --for-ask, some
// of those boxes since stopped. Before, each unused termag-3 main was a row of
// its own beside the asks; the explorers read chatListRows, so now none is.
const T = '2026-10-26T10:00:00Z';
const ws = (name: string, extra: Partial<Project['workstreams'][number]> = {}) => ({
  id: `${name}-id`, projectId: 'p', name, branch: name, archived: false, lastActiveAt: T, createdAt: T, updatedAt: T, ...extra,
});
const agent = [{ id: 'wf', type: 'agent', provider: 'claude' }] as unknown as Project['workflows'];
const project = (id: string, name: string, box: string, workstreams: ReturnType<typeof ws>[], extra: Partial<Project> = {}): Project => ({
  id, name, archived: false, createdAt: T, instanceId: box, workflows: agent, workstreams, ...extra,
});
const askChat = (n: number, extra: Partial<Project['workstreams'][number]> = {}) =>
  ws(`ask-cmvpvqxse19rwex4apfh33${n}ld`, { askThread: { id: `thr${n}aaaaaaaa`, title: `Task ${n}`, parentProjectId: 'orch', parentWorkstream: 'main' }, ...extra });

const PROJECTS: Project[] = [
  project('orch', 'orch', 'b0', [ws('main', { hasTurns: true })]),
  // Four ask projects made the old way: no createdFor, an unused main, one ask each from orch.
  ...[1, 2, 3, 4].map(n => project(`t${n}`, 'termag-3', `ask${n}`, [ws('main'), askChat(n)])),
  // One where someone did work in main: it stays.
  project('t5', 'termag-3', 'ask5', [ws('main', { hasTurns: true }), askChat(5)]),
];
// ask1 and ask2 are stopped: their statuses are gone (not running); ask3's agent sits at its prompt.
const STATUS = { 'ask3|zmay-termag-3-agent': { status: 'idle' } } as never;
const shape = (nodes: ReadonlyArray<AgentNode<InboxRow>>): unknown[] =>
  nodes.map(n => (n.children.length ? [agentLabel(n.row), shape(n.children)] : agentLabel(n.row)));
const links = (rows: InboxRow[]) => rows.flatMap(r => (r.askParent ? [{ projectId: r.projectId, workstream: r.workstream, parentProjectId: r.askParent.projectId, parentWorkstream: r.askParent.workstream }] : []));

describe('the explorers fold an ask project\'s unused main (#884)', () => {
  it('Agents (no space): each ask under its sender, no unused termag-3 rows, stopped box or not', () => {
    const rows = chatListRows(PROJECTS, STATUS, 'zmay', new Set());
    expect(shape(noSpaceAgents(rows, [], new Map(), links(rows)))).toEqual([
      ['orch', ['Task 1', 'Task 2', 'Task 3', 'Task 4', 'Task 5']],
      'termag-3',
    ]);
    // The one termag-3 left is t5's, whose main was used.
    expect(rows.filter(r => r.projectName === 'termag-3' && r.workstream === 'main').map(r => r.projectId)).toEqual(['t5']);
  });

  it('a space\'s explorer the same way', () => {
    const rows = chatListRows(PROJECTS, STATUS, 'zmay', new Set());
    const index = new Map(['b0', 'ask1', 'ask2', 'ask3', 'ask4', 'ask5'].map(b => [b, ['notes']]));
    expect(shape(explorerAgents(rows, 'notes', index, links(rows)))).toEqual([
      ['orch', ['Task 1', 'Task 2', 'Task 3', 'Task 4', 'Task 5']],
      'termag-3',
    ]);
  });

  it('keeps an unused main that is open in a tab, or working now', () => {
    const working = { 'ask4|zmay-termag-3-agent': { status: 'working' } } as never;
    const rows = chatListRows(PROJECTS, working, 'zmay', new Set(['t1|main']));
    expect(rows.filter(r => r.workstream === 'main').map(r => r.projectId).sort()).toEqual(['orch', 't1', 't4', 't5']);
  });
});

describe('a main used since the project list was read is never folded (Bugbot, #884)', () => {
  // The /api/projects snapshot still says t1's main is unused (no hasTurns yet): only its live status knows.
  it('keeps a main whose live status came to rest after a turn (stoppedAt), though the snapshot says unused', () => {
    const rested = { 'ask1|zmay-termag-3-agent': { status: 'idle', stoppedAt: '2026-10-28T21:00:00Z' } } as never;
    const rows = chatListRows(PROJECTS, rested, 'zmay', new Set());
    expect(rows.some(r => r.projectId === 't1' && r.workstream === 'main')).toBe(true);
  });

  it('keeps a main seen working on this page after it goes back to Ready, before the list is read again', () => {
    const seen = new Set<string>();
    const working = { 'ask2|zmay-termag-3-agent': { status: 'working' } } as never;
    expect(chatListRows(PROJECTS, working, 'zmay', new Set(), seen).some(r => r.projectId === 't2' && r.workstream === 'main')).toBe(true);
    // Its turn ends; the live status loses it (a restart, a box reconnect) and the snapshot is the old one.
    const ready = { 'ask2|zmay-termag-3-agent': { status: 'idle' } } as never;
    expect(chatListRows(PROJECTS, ready, 'zmay', new Set(), seen).some(r => r.projectId === 't2' && r.workstream === 'main')).toBe(true);
    expect(chatListRows(PROJECTS, {} as never, 'zmay', new Set(), seen).some(r => r.projectId === 't2' && r.workstream === 'main')).toBe(true);
  });

  it('still folds a main that has only ever sat at its prompt', () => {
    const seen = new Set<string>();
    const ready = { 'ask3|zmay-termag-3-agent': { status: 'idle' } } as never;
    expect(chatListRows(PROJECTS, ready, 'zmay', new Set(), seen).some(r => r.projectId === 't3' && r.workstream === 'main')).toBe(false);
  });
});
