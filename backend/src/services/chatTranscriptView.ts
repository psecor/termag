/**
 * What a stored chat transcript renders as: the
 * `chat-history` entries the simple UI's `fromHistory` reads, derived from
 * Claude Code's raw session JSONL on the orchestrator, with large parts cut
 * down. Pure: no Prisma, no crypto.
 *
 * The derivation follows the box runner's `historyEntries`
 * (agent/chat-runner.js) and adds one rule the box's reader doesn't have: a
 * slash command's output, which Claude Code writes as a `system` line with
 * subtype `local_command`, becomes a user-role entry with that content, the
 * shape `localCommand` (frontend/src/chat/sdkChat.ts) already renders as
 * "Ran /x: output".
 */

/** A tool call's input string longer than this keeps only its first TOOL_INPUT_KEEP bytes. */
export const TOOL_INPUT_MAX = 2048;
export const TOOL_INPUT_KEEP = 1024;
/** Tool result text longer than this keeps only its first RESULT_KEEP bytes: about the 20,000 characters the live chat shows. */
export const RESULT_MAX = 20 * 1024;
export const RESULT_KEEP = 16 * 1024;
/** Thinking longer than this keeps only its first THINKING_KEEP bytes. */
export const THINKING_MAX = 4096;
export const THINKING_KEEP = 2048;
/** Any other text block (the person's, Claude's reply, a slash command's output) is cut at this many bytes. */
export const BLOCK_MAX = 64 * 1024;
export const IMAGE_PLACEHOLDER = '[image]';

export interface ViewEntry {
  type: 'user' | 'assistant';
  uuid?: string;
  timestamp?: string;
  isMeta?: true;
  sourceToolUseID?: string;
  message: { id?: string; role: unknown; model?: string; content: unknown };
}

/** The first `keep` bytes of `text` (never splitting a character), and a note of what was cut. */
export function cut(text: string, max: number, keep: number): string {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes <= max) return text;
  let head = Buffer.from(text, 'utf8').subarray(0, keep).toString('utf8');
  if (head.endsWith('\uFFFD')) head = head.slice(0, -1);
  return `${head}… [${bytes - Buffer.byteLength(head, 'utf8')} bytes elided]`;
}

function elideInput(value: unknown): unknown {
  if (typeof value === 'string') return cut(value, TOOL_INPUT_MAX, TOOL_INPUT_KEEP);
  if (Array.isArray(value)) return value.map(elideInput);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, elideInput(v)]));
  }
  return value;
}

function elideResultContent(content: unknown): unknown {
  if (typeof content === 'string') return cut(content, RESULT_MAX, RESULT_KEEP);
  if (!Array.isArray(content)) return content;
  return content.map(part => {
    if (!part || typeof part !== 'object') return part;
    const p = part as Record<string, unknown>;
    if (p.type === 'image') return { type: 'text', text: IMAGE_PLACEHOLDER };
    if (p.type === 'text' && typeof p.text === 'string') return { ...p, text: cut(p.text, RESULT_MAX, RESULT_KEEP) };
    return part;
  });
}

function elideBlock(block: unknown): unknown {
  if (!block || typeof block !== 'object') return block;
  const b = block as Record<string, unknown>;
  switch (b.type) {
    case 'image': return { type: 'text', text: IMAGE_PLACEHOLDER };
    case 'text': return typeof b.text === 'string' ? { ...b, text: cut(b.text, BLOCK_MAX, BLOCK_MAX) } : b;
    case 'tool_use': return { ...b, input: elideInput(b.input) };
    case 'tool_result': return { ...b, content: elideResultContent(b.content) };
    case 'thinking': {
      if (typeof b.thinking !== 'string') return b;
      const { signature: _signature, ...rest } = b;
      return { ...rest, thinking: cut(b.thinking, THINKING_MAX, THINKING_KEEP) };
    }
    case 'redacted_thinking': return { type: 'thinking', thinking: '' };
    default: return block;
  }
}

/** One entry with its large parts cut down. */
export function elideEntry(entry: ViewEntry): ViewEntry {
  const content = entry.message.content;
  if (typeof content === 'string') return { ...entry, message: { ...entry.message, content: cut(content, BLOCK_MAX, BLOCK_MAX) } };
  if (!Array.isArray(content)) return entry;
  return { ...entry, message: { ...entry.message, content: content.map(elideBlock) } };
}

/**
 * What stands in for a transcript line too long for the box to read
 * (agent/transcript-lines.js LINE_MAX_BYTES). `<synthetic>` marks it as
 * Claude Code's, not the model's.
 */
export function tooLargeEntry(bytes: number): ViewEntry {
  const mb = Math.round(bytes / (1024 * 1024));
  return {
    type: 'assistant',
    message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: `[A message of ${mb} MB was too large to keep]` }] },
  };
}

function viewEntry(e: Record<string, unknown>, boxNotices: boolean): ViewEntry | null {
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
  if (e.type === 'system') {
    if (e.subtype !== 'local_command' || typeof e.content !== 'string') return null;
    return { type: 'user', uuid: str(e.uuid), timestamp: str(e.timestamp), message: { role: 'user', content: e.content } };
  }
  if (e.type !== 'user' && e.type !== 'assistant') return null;
  const message = e.message as Record<string, unknown> | undefined;
  if (e.isSidechain || !message || typeof message !== 'object') return null;
  // Claude Code's meta lines stay out, except those a tool call added (a
  // skill's SKILL.md after its Skill call), which the browser folds into it.
  const toolMeta = e.isMeta === true && e.type === 'user' && typeof e.sourceToolUseID === 'string';
  if (e.isMeta && !toolMeta) return null;
  return {
    type: e.type,
    uuid: str(e.uuid),
    timestamp: str(e.timestamp),
    ...(toolMeta && { isMeta: true as const, sourceToolUseID: e.sourceToolUseID as string }),
    message: {
      id: str(message.id),
      role: message.role,
      // `<synthetic>` marks a message Claude Code wrote itself (a refused command), not the model.
      ...(typeof message.model === 'string' && { model: message.model }),
      content: e.type === 'user' ? withoutSpaceMemoryNotice(boxNotices ? withoutBoxNotice(message.content) : message.content) : message.content,
    },
  };
}

// The runner's note of what happened to the box (agent/box-notice.js) leads a
// user message's text; the person never typed it, so the view leaves it out.
// A runner that inserts notices (chat-box-notice-v1) defuses sender text that
// opens with the tag, so a leading block is always one it inserted. From a
// runner that inserts none, nothing is stripped: a leading block there is the
// sender's own.
const BOX_NOTICE = /^<termag-box-notice>[\s\S]*?<\/termag-box-notice>\n*/;

// Space memory's notice of a change (agent/space-memory.js) comes next, ahead
// of the person's text; the runner strips it from everything it sends
// (stripNotice), so the stored view does too.
const SPACE_MEMORY_NOTICE = /^<space-memory-notice>[\s\S]*?<\/space-memory-notice>\n*/;

/** A user message's content without a leading block `re` matches: a string, or its first text block. */
function withoutLeading(content: unknown, re: RegExp): unknown {
  if (typeof content === 'string') return content.replace(re, '');
  if (!Array.isArray(content)) return content;
  const i = content.findIndex(p => p && typeof p === 'object' && (p as { type?: unknown }).type === 'text' && typeof (p as { text?: unknown }).text === 'string');
  if (i < 0) return content;
  const block = content[i] as { text: string };
  if (!re.test(block.text)) return content;
  const text = block.text.replace(re, '');
  if (!text && content.length > 1) return content.filter((_, j) => j !== i);
  return content.map((p, j) => (j === i ? { ...block, text } : p));
}

/** A user message's content without the box notice: a string, or its first text block. */
export function withoutBoxNotice(content: unknown): unknown {
  return withoutLeading(content, BOX_NOTICE);
}

/** A user message's content without space memory's notice, which follows any box notice. */
export function withoutSpaceMemoryNotice(content: unknown): unknown {
  return withoutLeading(content, SPACE_MEMORY_NOTICE);
}

/** The elided entries whole JSONL lines render as. Lines that don't parse are skipped. */
/** `boxNotices`: the lines come from a runner with chat-box-notice-v1, whose leading notices are its own. */
export function transcriptEntries(jsonl: string, { boxNotices = true }: { boxNotices?: boolean } = {}): ViewEntry[] {
  const out: ViewEntry[] = [];
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    let e: unknown;
    try { e = JSON.parse(line); } catch { continue; }
    if (!e || typeof e !== 'object' || Array.isArray(e)) continue;
    const entry = viewEntry(e as Record<string, unknown>, boxNotices);
    if (entry) out.push(elideEntry(entry));
  }
  return out;
}
