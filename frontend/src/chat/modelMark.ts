// Which maker's mark a session's sidebar card wears: the model it runs on,
// not the harness that runs it. A Fireworks model runs in the same
// claude-chat runner as Claude, so the agent workflow's
// `backend` and `model` decide it; another harness (Codex, Cursor, Devin…)
// is its own maker. pages/chat/ModelMark.tsx draws them.
import type { Project } from '../types';

export type ModelMaker =
  | 'claude' | 'kimi' | 'glm' | 'deepseek' | 'qwen' | 'llama' | 'fireworks'
  | 'codex' | 'cursor' | 'devin' | 'gemini' | 'other';

export interface ModelMarkInfo { maker: ModelMaker; label: string }

const FIREWORKS: ReadonlyArray<[RegExp, ModelMaker, string]> = [
  [/kimi/i, 'kimi', 'Kimi'],
  [/glm/i, 'glm', 'GLM'],
  [/deepseek/i, 'deepseek', 'DeepSeek'],
  [/qwen/i, 'qwen', 'Qwen'],
  [/llama/i, 'llama', 'Llama'],
];

const HARNESS: Record<string, ModelMarkInfo> = {
  claude: { maker: 'claude', label: 'Claude' },
  'claude-chat': { maker: 'claude', label: 'Claude' },
  codex: { maker: 'codex', label: 'Codex' },
  cursor: { maker: 'cursor', label: 'Cursor' },
  'cursor-chat': { maker: 'cursor', label: 'Cursor' },
  devin: { maker: 'devin', label: 'Devin' },
  'devin-chat': { maker: 'devin', label: 'Devin' },
  gemini: { maker: 'gemini', label: 'Gemini' },
  deepseek: { maker: 'deepseek', label: 'DeepSeek' },
};

/** The mark for a session: its workstream's agent workflow, else the checkout's. */
export function modelMarkFor(
  project: Pick<Project, 'workflows'> | undefined, workstreamId: string | null | undefined, provider: string | null | undefined,
): ModelMarkInfo {
  const agents = project?.workflows.filter(w => w.type === 'agent') ?? [];
  const wf = (workstreamId ? agents.find(w => w.workstreamId === workstreamId) : undefined) ?? agents[0];
  if (wf?.backend === 'fireworks') {
    const hit = FIREWORKS.find(([re]) => re.test(wf.model ?? ''));
    return hit ? { maker: hit[1], label: hit[2] } : { maker: 'fireworks', label: 'Fireworks' };
  }
  const harness = provider ?? wf?.provider ?? null;
  return (harness && HARNESS[harness]) || { maker: 'other', label: harness ?? 'Agent' };
}
