import { describe, expect, it } from 'vitest';
import { agentForest, explorerAgents, searchAgents, type AgentNode, type SpawnLink } from './explorerAgents';

const row = (projectId: string, instanceId: string | null, workstream = 'main') => ({ projectId, workstream, projectName: projectId, instanceId });
const link = (child: string, parent: string, childWs = 'main'): SpawnLink => ({ projectId: child, workstream: childWs, parentProjectId: parent, parentWorkstream: 'main' });
type Row = ReturnType<typeof row>;
const shape = (nodes: Array<AgentNode<Row>>): unknown[] => nodes.map(n => (n.children.length ? [n.row.projectId + (n.row.workstream === 'main' ? '' : `/${n.row.workstream}`), shape(n.children)] : n.row.projectId));

describe('agentForest', () => {
  it('nests an agent under the one that started it, by name at each level', () => {
    const rows = [row('zed', 'b'), row('boss', 'b'), row('kid-b', 'b'), row('kid-a', 'b'), row('grandkid', 'b'), row('alone', 'b')];
    const links = [link('kid-b', 'boss'), link('kid-a', 'boss'), link('grandkid', 'kid-a')];
    expect(shape(agentForest(rows, links))).toEqual(['alone', ['boss', [['kid-a', ['grandkid']], 'kid-b']], 'zed']);
  });

  it('keeps a child at the top when its starter isn\'t listed, and breaks a loop', () => {
    const rows = [row('kid', 'b'), row('a', 'b'), row('c', 'b')];
    expect(shape(agentForest(rows, [link('kid', 'elsewhere'), link('a', 'c'), link('c', 'a')]))).toEqual(['a', 'c', 'kid']);
  });

  it('nests a workstream another session started under it', () => {
    const rows = [row('p', 'b'), row('p', 'b', 'fix')];
    expect(shape(agentForest(rows, [link('p', 'p', 'fix')]))).toEqual([['p', ['p']]]);
  });
});

describe('explorerAgents', () => {
  it('lists only the agents whose box reaches the space, as a tree', () => {
    const rows = [row('in', 'b1'), row('kid', 'b1'), row('far', 'b2'), row('loose', null)];
    const got = explorerAgents(rows, 'notes', new Map([['b1', ['notes']], ['b2', ['design']]]), [link('kid', 'in')]);
    expect(shape(got)).toEqual([['in', ['kid']]]);
  });

  it('searches agent names at every depth', () => {
    const forest = agentForest([row('review-notes', 'b'), row('notes-kid', 'b'), row('other', 'b')], [link('notes-kid', 'review-notes')]);
    expect(searchAgents(forest, 'notes').map(r => r.projectId)).toEqual(['review-notes', 'notes-kid']);
    expect(searchAgents(forest, 'kid notes').map(r => r.projectId)).toEqual(['notes-kid']);
    expect(searchAgents(forest, '  ')).toEqual([]);
  });
});
