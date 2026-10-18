import type { AgentStatus, Project, StatusMap } from '../types';
import { sessionName } from './sessionName';
import { statusKey } from './statusKey';

export type FaviconState = 'attention' | 'working' | 'quiet' | 'stale';

export interface FaviconInput {
  projects: Project[];
  statusMap: StatusMap;
  username: string;
  offline: boolean;
}

type Session = Pick<AgentStatus, 'status' | 'rateLimited'>;

interface Rule {
  state: FaviconState;
  matches: (offline: boolean, sessions: Session[]) => boolean;
}

const RULES: Rule[] = [
  { state: 'stale', matches: offline => offline },
  { state: 'attention', matches: (_, s) => s.some(x => x.status === 'waiting' || !!x.rateLimited) },
  { state: 'working', matches: (_, s) => s.some(x => x.status === 'working') },
];

export const FAVICON_PALETTE: Record<FaviconState, { bg: string; border: string; chevron: string; underscore: string }> = {
  quiet: { bg: '#0d1117', border: '#30363d', chevron: '#58a6ff', underscore: '#3fb950' },
  working: { bg: '#238636', border: '#2ea043', chevron: '#e6edf3', underscore: '#e6edf3' },
  attention: { bg: '#d29922', border: '#e3b341', chevron: '#0d1117', underscore: '#0d1117' },
  stale: { bg: '#30363d', border: '#484f58', chevron: '#8b949e', underscore: '#8b949e' },
};

function ownAgentSessions({ projects, statusMap, username }: FaviconInput): Session[] {
  return projects
    .filter(p => p.role !== 'collaborator' && p.workflows.some(w => w.type === 'agent'))
    .flatMap(p => {
      const owner = p.ownerUsername ?? username;
      const workstreams = p.workstreams ?? [];
      const names = workstreams.length === 0
        ? [sessionName(owner, p.name, 'agent')]
        : workstreams.map(ws => sessionName(owner, p.name, 'agent', ws.name));
      return names.map(s => statusMap[statusKey(p.instanceId, s)] ?? { status: 'not_running' as const });
    });
}

export function faviconState(input: FaviconInput): FaviconState {
  const sessions = ownAgentSessions(input);
  return RULES.find(r => r.matches(input.offline, sessions))?.state ?? 'quiet';
}

export function faviconSvg(state: FaviconState): string {
  const c = FAVICON_PALETTE[state];
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">',
    `<rect x="1" y="1" width="30" height="30" rx="7" fill="${c.bg}" stroke="${c.border}" stroke-width="2"/>`,
    `<path d="M8 10.5 L14 16 L8 21.5" fill="none" stroke="${c.chevron}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`,
    `<path d="M16.5 22 H24" stroke="${c.underscore}" stroke-width="3" stroke-linecap="round"/>`,
    '</svg>',
  ].join(' ');
}

export function faviconHref(state: FaviconState): string {
  return 'data:image/svg+xml,' + encodeURIComponent(faviconSvg(state));
}
