// The simple UI's new-chat composer: which repository and which model a
// start carries. The tiers are the ones termag's gateway and Claude Code
// both accept (backend services/claudeChatModel.ts).
// There is no Auto: it was never a router termag owns, only an omitted
// `--model` flag. A start with no chosen tier runs on Sonnet.
// A viewer with Fireworks on also gets their fireworks-models.
import type { ModelChoice } from '../services/api';
import { createBody, repoKey, type RepoCatalog, type RepoPick } from '../utils/repoPick';

export const CHAT_MODELS = [
  { id: 'opus', label: 'Opus 5.5' },
  { id: 'sonnet', label: 'Sonnet 5.5' },
  { id: 'haiku', label: 'Haiku 4.5' },
] as const;

type ClaudeTier = (typeof CHAT_MODELS)[number]['id'];

/** A Claude tier, or `fireworks:<model id>` for one of the viewer's Fireworks models. */
export type ChatModelId = string;

const FIREWORKS = 'fireworks:';
const FIREWORKS_ID = /^accounts\/[a-z0-9-]+\/(?:models|routers)\/[A-Za-z0-9._-]+$/;

function isClaudeTier(id: string): id is ClaudeTier {
  return CHAT_MODELS.some(m => m.id === id);
}

export function isChatModel(id: string): boolean {
  return isClaudeTier(id) || (id.startsWith(FIREWORKS) && FIREWORKS_ID.test(id.slice(FIREWORKS.length)));
}

/** What a send carries for the model (backend routes/chat.ts): a tier, or a Fireworks model with its backend. */
export function chatModelWire(id: ChatModelId): { model: string; backend?: 'fireworks' } {
  return id.startsWith(FIREWORKS) ? { model: id.slice(FIREWORKS.length), backend: 'fireworks' } : { model: id };
}

/** The model runs on Claude's own backend (PDFs go to Claude only, backend services/chatImages.ts). */
export function chatModelTakesPdfs(id: ChatModelId | null): boolean {
  return !chatModelWire(id ?? '').backend;
}

/** A Fireworks chat whose model the history could not say: no option, so any pick switches it. */
export const FIREWORKS_UNKNOWN: ChatModelId = FIREWORKS;

/** A history's `model` and `backend` as a ChatModelId; null for one this page cannot show. */
export function chatModelFromWire(model: unknown, backend?: unknown): ChatModelId | null {
  if (backend === 'fireworks') return typeof model === 'string' && FIREWORKS_ID.test(model) ? FIREWORKS + model : FIREWORKS_UNKNOWN;
  return typeof model === 'string' && isClaudeTier(model) ? model : null;
}

export interface ChatModelOption {
  id: ChatModelId;
  label: string;
  /** Fireworks' models, under their own heading. */
  fireworks?: boolean;
}

/** Claude's tiers, then the viewer's Fireworks models. */
export function chatModelOptions(fireworks: ModelChoice[]): ChatModelOption[] {
  return [
    ...CHAT_MODELS.map(m => ({ id: m.id, label: m.label })),
    ...fireworks.map(m => ({ id: FIREWORKS + m.id, label: m.label, fireworks: true })),
  ];
}

/**
 * Claude Code's effort levels (`--effort`), offered beside the model where the
 * chat takes one (backend services/chatEffort.ts). Default sends nothing, so the
 * turn runs at what Claude Code picks for the model.
 */
export const CHAT_EFFORTS = [
  { id: 'default', label: 'Default', hint: 'What Claude Code picks for the model' },
  { id: 'low', label: 'Low', hint: 'Quickest, for small asks' },
  { id: 'medium', label: 'Medium', hint: 'Quick, with some thought' },
  { id: 'high', label: 'High', hint: 'Thinks it through' },
  { id: 'xhigh', label: 'Extra high', hint: 'Thinks longer, for hard problems' },
  { id: 'max', label: 'Max', hint: 'Deepest thinking, slowest' },
] as const;

/** The slider's stops, low to max. Default is not an intensity: it has its own control. */
export const EFFORT_LEVELS = CHAT_EFFORTS.filter((e): e is Exclude<(typeof CHAT_EFFORTS)[number], { id: 'default' }> => e.id !== 'default');

export type ChatEffortId = (typeof CHAT_EFFORTS)[number]['id'];
/** What a send carries as `effort`: a level the CLI takes. Default is no value. */
export type ChatEffortWire = Exclude<ChatEffortId, 'default'>;

export function isChatEffort(id: unknown): id is ChatEffortId {
  return typeof id === 'string' && CHAT_EFFORTS.some(e => e.id === id);
}

export function chatEffortWire(id: ChatEffortId): ChatEffortWire | null {
  return id === 'default' ? null : id;
}

export function chatEffortLabel(id: ChatEffortId): string {
  return CHAT_EFFORTS.find(e => e.id === id)?.label ?? 'Default';
}

/** Fireworks' models run at their own effort: the picker offers none for them. */
export function chatModelTakesEffort(id: ChatModelId | null): boolean {
  return id == null || !id.startsWith(FIREWORKS);
}

export function chatModelLabel(id: ChatModelId, options: ChatModelOption[] = []): string {
  const known = options.find(o => o.id === id) ?? CHAT_MODELS.find(m => m.id === id);
  if (known) return known.label;
  if (id === FIREWORKS_UNKNOWN) return 'Fireworks';
  return id.startsWith(FIREWORKS) ? id.split('/').pop() ?? id : 'Sonnet 5.5';
}

/**
 * A model's name without its version, for the placeholder (the picker keeps
 * the full label): the words before the first one with a digit, "Kimi K3" →
 * "Kimi", "DeepSeek V4.1 Flash" → "DeepSeek"; a version fused to the name
 * comes off it, "Qwen3 Coder" → "Qwen".
 */
export function modelFamily(label: string): string {
  const words = label.trim().split(/[\s_-]+/).filter(Boolean);
  const versioned = words.findIndex(w => /\d/.test(w));
  if (versioned !== 0) return (versioned < 0 ? words : words.slice(0, versioned)).join(' ') || label;
  return words[0].replace(/\d[\d.]*[a-z]*$/i, '') || label;
}

/**
 * Who the composer's placeholder addresses: Claude on its tiers, a Fireworks
 * model by its name without the version. Null while the chat's model is
 * unknown, so a Kimi chat never reads "Message Claude…" before its history
 * reports.
 */
export function chatAgentName(id: ChatModelId | null, options: ChatModelOption[] = []): string | null {
  if (id == null || id === FIREWORKS_UNKNOWN) return null;
  return isClaudeTier(id) ? 'Claude' : modelFamily(chatModelLabel(id, options));
}

/** The tier a create carries as claudeModel; a Fireworks model is null. */
export function claudeModelForCreate(id: ChatModelId): 'opus' | 'sonnet' | 'haiku' | null {
  return isClaudeTier(id) ? id : null;
}

export interface NewChatCreateFields {
  repoUrl: string;
  defaultBranch: string | null;
  claudeModel: 'opus' | 'sonnet' | 'haiku' | null;
  /** A Fireworks model: the chat's agent starts on that backend. */
  backend?: 'fireworks';
  model?: string;
}

/**
 * The repository and model half of a new-chat create. Null until a repository
 * is chosen: a listed repo, or a pasted GitHub URL. An empty directory is not
 * a start.
 */
export function newChatCreateFields(pick: RepoPick, model: ChatModelId): NewChatCreateFields | null {
  if (pick.kind === 'empty' || pick.kind === 'starter') return null;
  if (pick.kind === 'pasted' && !repoKey(pick.url)) return null;
  const body = createBody(pick);
  if (!body || body.repoUrl == null) return null;
  return {
    repoUrl: body.repoUrl,
    defaultBranch: body.defaultBranch,
    claudeModel: claudeModelForCreate(model),
    ...(chatModelWire(model).backend ? chatModelWire(model) : {}),
  };
}

export function repoTriggerLabel(pick: RepoPick): string {
  if (pick.kind === 'listed') return pick.fullName;
  if (pick.kind === 'pasted') return repoKey(pick.url) ?? (pick.url.trim() || 'Choose a repository');
  return 'Choose a repository';
}

export const REPO_LOAD_ERROR = 'Could not load repositories. Paste a URL, or try again.';
export const REPO_EMPTY = 'No repositories on this account. Paste a URL to use one that is not listed.';

export type RepoListView =
  | { kind: 'loading' }
  | { kind: 'error'; text: string }
  | { kind: 'empty' }
  | { kind: 'ready' };

export function repoListView(catalog: RepoCatalog | null): RepoListView {
  if (!catalog) return { kind: 'loading' };
  if (!catalog.ok) {
    const notice = catalog.notice ?? '';
    const text = notice.startsWith('Could not load') || notice === '' ? REPO_LOAD_ERROR : notice;
    return { kind: 'error', text };
  }
  const any = catalog.groups.some(g => g.repos.length > 0 || g.status !== 'ok');
  return any ? { kind: 'ready' } : { kind: 'empty' };
}
