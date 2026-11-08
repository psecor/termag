/**
 * chatSessionRows (the desktop's GET /api/cli/v1/chats) lists the sessions
 * termag web's sidebar lists, under the same names: the browser's own
 * chatListRows and chatRowName run on the same projects and statuses here,
 * and the two must agree. When this fails, the simple UI changed which
 * sessions it lists or what it calls them: change chatSessionRows to match.
 */
import { describe, expect, it } from 'vitest';
import { chatListRows, chatRowName } from '../../../frontend/src/chat/simpleChat';
import type { AgentStatus as WebStatus, Project as WebProject } from '../../../frontend/src/types';
import type { AgentStatus } from '../types';
import { chatSessionRows, type ChatSourceProject } from './chatSessionRows';
import { statusKey } from './statusKey';

const at = '2026-10-31T10:00:00.000Z';
const agent = (provider: string, workstreamId: string | null = null) => ({ type: 'agent', provider, workstreamId });
const ws = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id, name, archived: false, sessionTitle: null, spaceId: null, spaceFixedAt: null, updatedAt: at,
  hasTranscript: false, askThread: null, ...extra,
});

const projects: ChatSourceProject[] = [
  {
    id: 'p-app', name: 'app', instanceId: 'box-1', kind: 'normal', lastActiveAt: at,
    workflows: [agent('claude-chat')],
    workstreams: [
      ws('w-main', 'main', { sessionTitle: 'Fix the login page', hasTranscript: true, hasTurns: true }),
      ws('w-feat', 'feature', { sessionTitle: '  ' }),
      ws('w-old', 'old', { archived: true }),
    ],
  },
  { id: 'p-empty', name: 'empty', instanceId: 'box-2', kind: 'normal', workflows: [agent('claude')], workstreams: [] },
  {
    id: 'p-nightly', name: 'nightly', instanceId: 'box-1', kind: 'automation',
    workflows: [agent('claude-chat')],
    workstreams: [ws('w-n-main', 'main'), ws('w-n-run', 'run-20261031')],
  },
  { id: 'p-meta', name: 'meta', instanceId: 'box-1', kind: 'metaterm', workflows: [agent('claude')], workstreams: [ws('w-m', 'main')] },
  // A space's Slack orchestrator: never a session the sidebar lists (projectKind.ts).
  { id: 'p-space', name: 'space-team', instanceId: 'box-1', kind: 'space-orchestrator', workflows: [agent('claude-chat')], workstreams: [ws('w-sp', 'main'), ws('w-sp-2', 'slack-c1')] },
  { id: 'p-gone', name: 'gone', instanceId: 'box-1', archived: true, workflows: [agent('claude-chat')], workstreams: [ws('w-g', 'main')] },
  { id: 'p-shell', name: 'shell', instanceId: 'box-1', workflows: [{ type: 'shell', provider: null, workstreamId: null }], workstreams: [ws('w-s', 'main')] },
  {
    // An ask project: its main stands in for the asks and is folded out.
    id: 'p-asks', name: 'asks', instanceId: 'box-3', kind: 'normal', createdFor: 'ask',
    workflows: [agent('claude-chat')],
    workstreams: [
      ws('w-a-main', 'main'),
      ws('w-a-1', 'ask-abcdef1234', { askThread: { id: 'abcdef1234', title: 'Review the PR', parentProjectId: 'p-app', parentWorkstream: 'main' } }),
      ws('w-a-2', 'ask-1234abcdef', { askThread: { id: '1234abcdef', title: null }, sessionTitle: 'Checks the deploy' }),
    ],
  },
  {
    // An ask project whose main has had a turn (its status says so): kept.
    id: 'p-used', name: 'used', instanceId: 'box-3', kind: 'normal',
    workflows: [agent('claude-chat')],
    workstreams: [ws('w-u-main', 'main'), ws('w-u-1', 'ask-ffff0000aa', { askThread: { id: 'ffff0000aa', title: 'One' } })],
  },
  {
    // Shared with the viewer: owned by bob, whose tmux holds it.
    id: 'p-shared', name: 'shared', instanceId: 'box-9', kind: 'normal', role: 'collaborator', ownerUsername: 'bob',
    workflows: [agent('codex', 'w-sh')], workstreams: [ws('w-sh', 'main')],
  },
];

const statuses: Array<[string | null, string, Partial<AgentStatus>]> = [
  ['box-1', 'alice-app-agent', { status: 'working', source: 'chat-runner' }],
  ['box-1', 'alice-app-feature-agent', { status: 'waiting', waitingReason: 'approval', source: 't3:claude' }],
  ['box-3', 'alice-used-agent', { status: 'idle', stoppedAt: new Date(at) }],
  ['box-9', 'bob-shared-agent', { status: 'idle', source: 'codex' }],
];

const serverMap = new Map(statuses.map(([box, session, s]) =>
  [statusKey(box, session), { updatedAt: new Date(at), status: 'idle', ...s } as AgentStatus]));
const webMap: Record<string, WebStatus> = Object.fromEntries(statuses.map(([box, session, s]) => [
  statusKey(box, session),
  { updatedAt: at, status: 'idle', ...s, ...(s.stoppedAt ? { stoppedAt: at } : {}) } as unknown as WebStatus,
]));

const byKey = <R extends { key: string }>(rows: R[]) => [...rows].sort((a, b) => a.key.localeCompare(b.key));

describe('chatSessionRows mirrors the simple UI sidebar', () => {
  {
    it('lists the same sessions under the same names', () => {
      const web = chatListRows(projects as unknown as WebProject[], webMap, 'alice', new Set())
        .map(r => ({ ...r, ...chatRowName(r) }));
      const server = chatSessionRows(projects, serverMap, 'alice');
      const view = (r: { key: string; title: string | null; where: string | null; ask: boolean; provider: string | null; status: string; workstreamId?: string | null; shared: boolean }) =>
        ({ key: r.key, title: r.title, where: r.where, ask: r.ask, provider: r.provider, status: r.status, workstreamId: r.workstreamId ?? null, shared: r.shared });
      expect(byKey(server).map(r => view({ ...r, status: r.status.value }))).toEqual(byKey(web).map(view));
      // The fixture covers what changes a listing: kept, folded and left out.
      expect(server.map(r => r.key).sort()).toEqual([
        'p-app|feature', 'p-app|main', 'p-asks|ask-1234abcdef', 'p-asks|ask-abcdef1234', 'p-empty|main',
        'p-nightly|run-20261031', 'p-shared|main', 'p-used|ask-ffff0000aa', 'p-used|main',
      ]);
    });
  }
});

describe('chatSessionRows: what a row at rest needs', () => {
  const one = (st: Partial<AgentStatus>) => chatSessionRows(
    [{ id: 'p', name: 'app', instanceId: 'box-1', kind: 'normal', workflows: [agent('claude-chat')], workstreams: [ws('w', 'main')] }],
    new Map([[statusKey('box-1', 'alice-app-agent'), { updatedAt: new Date(at), status: 'idle', ...st } as AgentStatus]]),
    'alice',
  )[0].status;

  it("names a lost Claude sign-in as web's chat does, and a usage cap with its own words", () => {
    expect(one({ message: 'Not logged in · Please run /login' })).toMatchObject({ message: 'Not logged in · Please run /login', problem: 'auth', rateLimited: null });
    expect(one({ message: 'Working on it', rateLimited: 'resets 3:45pm' })).toMatchObject({ problem: 'rate-limited', rateLimited: 'resets 3:45pm' });
    expect(one({ message: 'Fixed the login page' })).toMatchObject({ message: 'Fixed the login page', problem: null });
    expect(one({})).toMatchObject({ message: null, problem: null, rateLimited: null });
  });
});
