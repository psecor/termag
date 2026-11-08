/**
 * The tags a Slack agent reply may carry (moved from agentSession.ts, M2):
 * `[react:…]`, `[choices:…]` and `[attach:…]`, taken out of the reply as it
 * streams (ReplyTagGate) or whole (stripTags), and the choice buttons.
 */

export type TagKind = 'react' | 'choices' | 'attach';

const TAG = /^\[(react|choices|attach):[ \t]*([^\]\n]*?)[ \t]*\]/i;
const TAG_OPENINGS = ['[react:', '[choices:', '[attach:'];
// Long enough for a few choice labels or a path.
const MAX_TAG_CHARS = 400;

/** Whether `text` (starting at a `[`) could still grow into a tag. */
function couldBeTag(text: string): boolean {
  if (text.length >= MAX_TAG_CHARS || text.includes(']') || text.includes('\n')) return false;
  const lower = text.toLowerCase();
  return TAG_OPENINGS.some(o => o.startsWith(lower) || lower.startsWith(o));
}

/**
 * Takes `[react:…]`, `[choices:…]` and `[attach:…]` tags out of a reply, wherever
 * Claude puts them (often after a tool call, not only at the top), and acts on
 * them. Never inside inline code or a fenced block: a reply that explains the
 * tags, or quotes code that holds one, keeps it as text. `choices` and `attach`
 * count only alone on a line (spaces aside), so a quoted file or PR line with
 * `[attach: notes.md]` in it never attaches anything; `react` may sit anywhere.
 *
 * Text that could still turn out either way is held back (a `[` that might grow
 * into a tag, backticks at a line's start that might open a fence, a choices or
 * attach tag whose line has not ended), so a stream never shows half a tag. A
 * tag on a line of its own takes its line break with it, and leading blank space
 * is dropped. Chunking does not change the output, so the streamed text and the
 * final text come out the same.
 */
export class ReplyTagGate {
  private held = '';
  private skip: 'none' | 'spaces' | 'line' = 'none';
  private lastChar = '';
  /** Nothing but spaces or tabs so far on the current line. */
  private lineBlank = true;
  private inFence = false;
  private inCode = false;
  /** A choices/attach tag at a line's start, waiting to see whether its line ends. */
  private ownLine: { kind: TagKind; value: string; raw: string } | null = null;
  /** A line's leading spaces, held until it is known whether the line is a tag. */
  private indent = '';

  constructor(private onTag: (kind: TagKind, value: string) => void, private onText: (text: string) => void) {}

  push(chunk: string): void {
    const text = this.held + chunk;
    this.held = '';
    this.scan(text, false);
  }

  /** Lets go of anything held back. Call once the reply is complete. */
  end(): void {
    const held = this.held;
    this.held = '';
    this.scan(held, true);
  }

  private scan(text: string, final: boolean): void {
    let out = '';
    const put = (s: string) => {
      out += s;
      for (const c of s) {
        if (c === '\n') this.lineBlank = true;
        else if (c !== ' ' && c !== '\t') this.lineBlank = false;
      }
    };
    let i = 0;
    while (i < text.length) {
      const c = text[i];

      if (this.ownLine) {
        if (c === ' ' || c === '\t') { this.ownLine.raw += c; i++; continue; }
        const tag = this.ownLine;
        this.ownLine = null;
        if (c === '\n') { this.onTag(tag.kind, tag.value); i++; continue; }
        // Something follows it on the line: it was text all along.
        put(tag.raw);
        continue;
      }

      if (this.skip !== 'none') {
        if (c === ' ' || c === '\t') { i++; continue; }
        const lineMode = this.skip === 'line';
        this.skip = 'none';
        if (lineMode && c === '\n') { i++; continue; }
      }

      if (!this.inFence && this.lineBlank && (c === ' ' || c === '\t')) { this.indent += c; i++; continue; }
      if (this.indent) {
        if (c === '[') {
          const rest = text.slice(i);
          const m = rest.match(TAG);
          if (!m && !final && couldBeTag(rest)) { this.held = rest; break; }
          if (m && m[1].toLowerCase() !== 'react') {
            this.ownLine = { kind: m[1].toLowerCase() as TagKind, value: m[2], raw: this.indent + m[0] };
            this.indent = '';
            i += m[0].length;
            continue;
          }
        }
        put(this.indent);
        this.indent = '';
      }

      // A run of three or more backticks at a line's start opens or closes a fence.
      if (c === '`' && this.lineBlank && !this.inCode) {
        let run = 0;
        while (text[i + run] === '`') run++;
        if (i + run === text.length && !final && run < 3) { this.held = text.slice(i); break; }
        if (run >= 3) { this.inFence = !this.inFence; put(text.slice(i, i + run)); i += run; continue; }
      }
      if (this.inFence) { put(c); i++; continue; }
      if (c === '`') { this.inCode = !this.inCode; put(c); i++; continue; }
      if (c === '\n') { this.inCode = false; put(c); i++; continue; }
      if (this.inCode || c !== '[') { put(c); i++; continue; }

      const rest = text.slice(i);
      const m = rest.match(TAG);
      if (m) {
        const kind = m[1].toLowerCase() as TagKind;
        const atLineStart = this.lineBlank;
        if (kind === 'react') {
          this.onTag(kind, m[2]);
          const lineEmpty = (out ? out.slice(-1) : this.lastChar) === '\n' || (!out && !this.lastChar);
          this.skip = lineEmpty ? 'line' : 'spaces';
          i += m[0].length;
          continue;
        }
        if (atLineStart) {
          this.ownLine = { kind, value: m[2], raw: m[0] };
          i += m[0].length;
          continue;
        }
        put('[');
        i++;
        continue;
      }
      if (!final && couldBeTag(rest)) { this.held = rest; break; }
      put('[');
      i++;
    }
    // The reply's end closes the line a pending choices/attach tag is on.
    if (final && this.ownLine) {
      this.onTag(this.ownLine.kind, this.ownLine.value);
      this.ownLine = null;
    }
    if (final && this.indent) {
      put(this.indent);
      this.indent = '';
    }
    this.emit(out);
  }

  private emit(text: string): void {
    if (!this.lastChar) text = text.replace(/^\s+/, '');
    if (!text) return;
    this.lastChar = text.slice(-1);
    this.onText(text);
  }
}

const MAX_CHOICES = 5;
// Slack's limit for a button's text.
const MAX_CHOICE_CHARS = 75;

/** A `[react:…]` value as a Slack emoji name, or null. */
export function reactionName(value: string): string | null {
  const name = value.replace(/:/g, '').trim().toLowerCase();
  return /^[a-z0-9_+'-]+$/.test(name) ? name : null;
}

/** `[choices: A | B | C]` as button labels. */
export function choiceLabels(value: string): string[] {
  return value.split('|').map(c => c.trim()).filter(Boolean)
    .slice(0, MAX_CHOICES)
    .map(c => (c.length > MAX_CHOICE_CHARS ? `${c.slice(0, MAX_CHOICE_CHARS - 1)}…` : c));
}

export const CHOICE_ACTION = /^agent_choice_\d+$/;

/**
 * The buttons for a reply's choices. Each carries who may answer (the person
 * the reply was for), so in a channel nobody else can answer for them.
 */
export function choiceBlocks(labels: string[], forUser: string) {
  return [{
    type: 'actions',
    block_id: 'agent_choices',
    elements: labels.map((label, i) => ({
      type: 'button',
      text: { type: 'plain_text', text: label },
      action_id: `agent_choice_${i}`,
      value: JSON.stringify({ u: forUser, c: label }),
    })),
  }];
}

export function parseChoiceValue(value: string): { forUser: string; choice: string } | null {
  try {
    const v = JSON.parse(value);
    return typeof v?.u === 'string' && typeof v?.c === 'string' && v.c ? { forUser: v.u, choice: v.c } : null;
  } catch {
    return null;
  }
}

export type ReplyTags = { reaction: string | null; choices: string[]; attachments: string[]; text: string };

/** A whole reply with its tags taken out: the first reaction and choice list, every attachment. */
export function stripTags(reply: string): ReplyTags {
  const tags: ReplyTags = { reaction: null, choices: [], attachments: [], text: '' };
  const gate = new ReplyTagGate((kind, value) => {
    if (kind === 'react') tags.reaction ??= reactionName(value);
    else if (kind === 'choices' && !tags.choices.length) tags.choices = choiceLabels(value);
    else if (kind === 'attach' && value) tags.attachments.push(value);
  }, t => { tags.text += t; });
  gate.push(reply);
  gate.end();
  return tags;
}
