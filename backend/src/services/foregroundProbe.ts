import { ALL_PROCESS_NAMES } from '../providers/registry';

export function classifyForeground(cmd: string | null | undefined): 'running' | 'busy' | 'not-running' {
  const raw = cmd?.trim() ?? '';
  if (!raw) return 'not-running';
  const base = (raw.split('/').pop() ?? raw).toLowerCase();
  if (base === 'git' || base.startsWith('git-')) return 'busy';
  const lower = raw.toLowerCase();
  const looksLikeAgent = ALL_PROCESS_NAMES.some(name => lower.includes(name))
    || ['node', 'python'].some(name => lower.includes(name));
  return looksLikeAgent ? 'running' : 'not-running';
}
