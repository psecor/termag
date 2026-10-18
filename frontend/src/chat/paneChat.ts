// Pane → chat. Turns a tmux capture of an agent pane into blocks the chat
// clients (the phone's /m and the desktop's /chat) render as a conversation.
// Pure, no React, unit-tested
// from captured fixtures in paneChat.test.ts.
//
// Two modes:
//   'turns'  Claude Code. The pane has a chat grammar: `❯ ` echoes the user's
//            prompt, `● ` opens an assistant block (text, or a tool call when a
//            `⎿ ` result follows), `✻`/`※` lines and the input box are chrome.
//   'plain'  Everything else (pi, Devin, Cursor, the ctrl shell): one
//            monospace block. Providers with an input box still get the draft
//            and footer split off, so the transcript ends where the output does.
//
// When nothing in a capture matches, the result degrades to plain blocks —
// never to an empty transcript.

export type ChatMode = 'turns' | 'pi' | 'plain';

export type BlockKind =
  | 'you'      // the user's prompt as echoed by the CLI
  | 'agent'    // assistant prose
  | 'tool'     // a tool call; `result` holds the ⎿ lines
  | 'system'   // text before the first marker (shell banner, MOTD)
  | 'dialog'   // a CLI question box (Claude Code's AskUserQuestion / plan approval)
  | 'thinking' // pi's reasoning (grey italic in the pane): shown, but visibly secondary
  | 'plain';   // plain-mode body

export interface Block {
  kind: BlockKind;
  text: string;
  /** Tool output (`⎿` lines), joined. Only on 'tool'. */
  result?: string;
  /** The capture started inside this block; its head is missing. Claude blocks and pi tool boxes only: pi's prose has no head row to miss. */
  partial?: boolean;
  /** Dialog only: how many numbered options it offers (digit keys pick one). */
  options?: number;
  /** Tool only: the command failed (pi draws its box in the error colour). */
  failed?: boolean;
}

export interface ParsedPane {
  mode: ChatMode;
  blocks: Block[];
  /** Text sitting unsent in the CLI's input box; '' = empty box; null = no box found. */
  draft: string | null;
  /** The CLI's live progress line ("✻ Channeling… (1m 17s · ↓ 3.5k tokens)"), if visible. */
  spinner: string | null;
}

export interface ParseOptions {
  provider: string | null | undefined;
  /** `review` is the Devin PR-review pane: an agent CLI, so it gets the plain mode with box splitting. */
  role: 'agent' | 'ctrl' | 'review';
}

// SGR (colours, bold, dim) and the other CSI sequences tmux `-e` preserves.
// eslint-disable-next-line no-control-regex
const CSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
// Dim/grey text: SGR 2, or the 256-colour greys Claude Code and Devin use for
// placeholders and ghost text (232–250 + the standard 8 "bright black").
// eslint-disable-next-line no-control-regex
const DIM_RE = /\x1b\[(?:[0-9;]*;)?(?:2|90|38;5;(?:8|23[2-9]|24[0-9]|250))(?:;[0-9]*)*m/;

export function stripSgr(s: string): string {
  return s.replace(CSI_RE, '');
}

/** Which rendering a (provider, role) gets. */
export function chatMode(provider: string | null | undefined, role: 'agent' | 'ctrl' | 'review'): ChatMode {
  if (role === 'ctrl') return 'plain';
  if (provider === 'claude') return 'turns';
  // pi runs only in the agent pane; the review pane is always Devin.
  if (provider === 'pi' && role === 'agent') return 'pi';
  return 'plain';
}

// ── Line classes ───────────────────────────────────────────────────────────

const DIVIDER_RE = /^\s*─{8,}\s*\S{0,2}$/;             // "────…" (last glyph is often cut by the pane width)
const PROMPT_RE = /^(?:❯|›|>|❭)\s?(.*)$/;            // Claude ❯, pi >, Devin ❭
const AGENT_RE = /^[●⏺]\s?(.*)$/;                      // Claude Code's turn/tool marker (old builds used ⏺)
const RESULT_RE = /^\s*⎿\s?(.*)$/;
const SUMMARY_RE = /^[✻✶✳✢·]\s/;                      // "✻ Crunched for 45s · done 4:36 AM" and the spinner
const RECAP_RE = /^※\s/;                              // "※ recap: …" (+ indented continuation)
const CHROME_RE = [
  /^\s*\(disable recaps in \/config\)/,
  /^\s*new task\?\s+\/clear/,
  /^\s*✔ Update installed/,
  /^\s*⏵⏵ /,                                          // the permission-mode footer
  /^\s*\? for shortcuts/,
  /^\s*Tip:\s/,
  /^\s*⎿\s+Tip:\s/,
];
const CONTINUATION_RE = /^\s{2,}\S/;
const DIALOG_OPEN_RE = /^\s*[☐☑✓]\s/;                // " ☐ Direction " — a question box's title row
const DIALOG_CLOSE_RE = /^\s*(Enter to select|Enter to confirm|Esc to cancel)/;
const OPTION_RE = /^\s*(?:❯\s*)?\d+\.\s/;         // "❯ 1. Yes" / "  2. No"
const HIGHLIGHTED_OPTION_RE = /^\s*❯\s*\d+\.\s/;    // the option the cursor is on: the choice is live
// A continuation line that starts its own thing (bullet, numbered item, box
// drawing, code fence, shell prompt) is a hard line break, never a wrap.
const LIST_START_RE = /^\s*(?:[-*•▪◦]\s|\d+[.)]\s|[│┌└├┐┘┤┬┴┼╭╰╮╯─]|\$\s)/;
// A markdown code fence (pi prints raw markdown; Claude Code renders code
// without fences but indented deeper than prose, which the indent rule covers).
const FENCE_RE = /^\s*```/;
const MAX_BOX_LINES = 6;                                // an input box taller than this is something else

function isDivider(line: string): boolean { return DIVIDER_RE.test(line); }
function isChrome(line: string): boolean { return CHROME_RE.some(re => re.test(line)); }
function isSpinner(line: string): boolean {
  // Progress lines end in an ellipsis or carry a token/elapsed counter and no "done".
  return SUMMARY_RE.test(line) && !/\bdone\b/.test(line) && (/…|\.\.\./.test(line) || /\(\d/.test(line));
}

// ── Input box ──────────────────────────────────────────────────────────────

interface Split { body: string[]; draft: string | null; footer: string[] }

/**
 * Finds the CLI's input box: the last two divider lines of the pane. What is
 * between them is the draft (a prompt the user typed but has not sent);
 * what follows the last divider is the status footer. Operates on STYLED
 * lines so a dimmed placeholder can be told from typed text.
 */
function splitInputBox(styledLines: string[]): Split {
  const plain = styledLines.map(stripSgr);
  let bottom = -1;
  let top = -1;
  for (let i = plain.length - 1; i >= 0; i--) {
    if (!isDivider(plain[i])) continue;
    if (bottom === -1) { bottom = i; continue; }
    top = i;
    break;
  }
  // Need both edges, a short box, and a prompt on its first line — a question
  // dialog is also framed by dividers, and must not be read as a draft.
  const first = top === -1 ? '' : (plain.slice(top + 1, bottom).find(l => l.trim() !== '') ?? '');
  if (top === -1 || bottom - top - 1 > MAX_BOX_LINES || !PROMPT_RE.test(first.trimEnd()) || OPTION_RE.test(first)) {
    return { body: plain, draft: null, footer: [] };
  }
  const boxStyled = styledLines.slice(top + 1, bottom);
  const draftLines: string[] = [];
  for (const raw of boxStyled) {
    const line = stripSgr(raw);
    const m = PROMPT_RE.exec(line.trimEnd());
    const text = m ? m[1] : line.trim();
    if (text.length === 0) continue;
    // Ghost text / placeholder is dimmed; typed text is not.
    const afterPrompt = m ? raw.slice(raw.indexOf(m[0][0]) + 1) : raw;
    if (DIM_RE.test(afterPrompt)) continue;
    draftLines.push(text.trimEnd());
  }
  return { body: plain.slice(0, top), draft: draftLines.join('\n').trim(), footer: plain.slice(bottom + 1) };
}

// ── Turns (Claude Code) ────────────────────────────────────────────────────

/**
 * Append a continuation line to a block's text, undoing the CLI's wrapping.
 *
 * The CLI word-wraps prose at the pane width, and the pane can be narrow (a
 * phone-sized terminal attached to the tmux window shrinks it to ~28 cols),
 * so a hard `\n` per captured row leaves the phone with a column of short
 * lines. A row break is treated as a wrap when the next line's first word
 * would not have fit on the previous row; otherwise the CLI chose to break
 * there and the `\n` stays. Rows are only ever joined to a row at the same
 * indent: code (rendered deeper than prose), nested lists and quotes keep
 * their rows, as does everything inside a markdown fence. A row filled
 * exactly to the edge whose last word plus the next row's first word is one
 * token wider than a row (URL or path punctuation, or far too long to be two
 * words that met at the edge) is a word broken mid-way and is joined without
 * a space.
 */
interface WrapState {
  prevLen: number;      // width of the last row added to the block, marker and indent included
  prevIndent: number;   // its indent (the marker counts as indent on the head row)
  baseIndent: number;   // the block's prose indent (the head row's); deeper rows are code, quotes, nested lists
  inFence: boolean;     // inside a ``` block
}

function appendWrapped(cur: Block, s: WrapState, line: string, width: number): void {
  const next = line.trim();
  const indent = line.length - line.trimStart().length;
  const lastRow = cur.text.slice(cur.text.lastIndexOf('\n') + 1);
  const hard = () => { cur.text = cur.text ? `${cur.text}\n${next}` : next; };
  if (FENCE_RE.test(line)) { s.inFence = !s.inFence; return hard(); }
  if (s.inFence || !cur.text || lastRow === '' || width <= 0 || LIST_START_RE.test(line)) return hard();
  // Only prose at the block's own indent is rejoined: rows deeper than that
  // are code, a quote or a nested list, and keep their line structure.
  if (indent !== s.baseIndent || indent !== s.prevIndent) return hard();
  const firstWord = next.split(/\s+/)[0];
  // One column of slack: the CLI leaves the last column free on some rows.
  if (s.prevLen + 1 + firstWord.length <= width - 1) return hard();
  const lastWord = lastRow.split(/\s+/).pop() ?? '';
  const joined = lastWord + firstWord;
  const rowWidth = width - indent;
  const broken = s.prevLen === width && joined.length > rowWidth
    && (/[/:._@#?=&-]/.test(joined) || joined.length > rowWidth + 4);
  cur.text = `${cur.text}${broken ? '' : ' '}${next}`;
}

/**
 * A numbered-choice box that starts after a divider: Claude Code's permission
 * prompt (" Bash command … Do you want to proceed? ❯ 1. Yes / 2. Yes, and
 * don't ask again / 3. No") and anything else drawn the same way. It has no
 * ☐ title, so before this it fell through to muted "system" text. Needs a
 * highlighted `❯ N.` option (so the choice is live, not a list in prose) and
 * at least two options. Ends at the next divider, the footer, a row that
 * cannot be box content (a turn marker, a bare prompt echo, a turn summary
 * or recap — so a stale box with no terminator does not swallow the turns
 * after it), or the end of the pane. AskUserQuestion boxes (☐ title) are
 * left to the dialog path.
 */
function optionBox(body: string[], start: number): { block: Block; end: number } | null {
  const rows: string[] = [];
  let end = body.length - 1;
  for (let j = start; j < body.length; j++) {
    const l = body[j].trimEnd();
    if (isDivider(l)) { end = j - 1; break; }           // leave the divider to the main loop
    if (AGENT_RE.test(l) || SUMMARY_RE.test(l) || RECAP_RE.test(l) || (PROMPT_RE.test(l) && !OPTION_RE.test(l))) {
      end = j - 1; break;                                // the pane has moved on: leave that row to the main loop
    }
    if (DIALOG_CLOSE_RE.test(l)) { end = j; break; }     // the footer belongs to the box
    rows.push(l);
  }
  const first = rows.findIndex(r => r.trim() !== '');
  if (first === -1 || DIALOG_OPEN_RE.test(rows[first])) return null;
  if (!rows.some(r => HIGHLIGHTED_OPTION_RE.test(r))) return null;
  const options = rows.filter(r => OPTION_RE.test(r)).length;
  if (options < 2) return null;
  const kept = rows.slice(first);
  while (kept.length && kept[kept.length - 1].trim() === '') kept.pop();
  const indent = Math.min(...kept.filter(r => r.trim()).map(r => r.length - r.trimStart().length));
  const text = kept.map(r => r.slice(Math.min(indent, r.length - r.trimStart().length))).join('\n');
  return { block: { kind: 'dialog', text, options }, end };
}

function parseTurns(body: string[], width: number): { blocks: Block[]; spinner: string | null } {
  const blocks: Block[] = [];
  // Mutable cursor in an object: TypeScript cannot see assignments made in
  // the helper closures below, so a bare `let cur` narrows to `null` forever.
  const s = {
    cur: null as Block | null,
    inResult: false,     // continuation lines extend `cur.result`, not `cur.text`
    dropping: false,     // swallowing a recap's indented continuation
    dialog: false,       // inside a question box: lines are kept verbatim until its footer
    spinner: null as string | null,
    // Wrap state for appendWrapped; reset per block.
    prevLen: 0,
    prevIndent: 0,
    baseIndent: 0,
    inFence: false,
  };

  const push = (b: Block) => { s.cur = b; s.inResult = false; s.inFence = false; blocks.push(b); };
  const head = (line: string, text: string) => { s.prevLen = line.length; s.prevIndent = s.baseIndent = line.length - text.length; };
  const append = (text: string) => {
    const cur = s.cur;
    if (!cur) return;
    if (s.inResult) cur.result = cur.result ? `${cur.result}\n${text}` : text;
    else cur.text = cur.text ? `${cur.text}\n${text}` : text;
  };

  for (let i = 0; i < body.length; i++) {
    const line = body[i].trimEnd();
    if (s.dialog) {
      const cur = s.cur as Block;
      if (DIALOG_CLOSE_RE.test(line)) { s.dialog = false; s.cur = null; continue; }
      if (isDivider(line)) continue;
      if (OPTION_RE.test(line)) cur.options = (cur.options ?? 0) + 1;
      cur.text = cur.text ? `${cur.text}\n${line}` : line;
      continue;
    }
    if (isDivider(line)) {
      const box = optionBox(body, i + 1);
      if (box) { push(box.block); s.cur = null; s.dropping = false; i = box.end; continue; }
    }
    if (DIALOG_OPEN_RE.test(line)) {
      push({ kind: 'dialog', text: line.trim(), options: 0 });
      s.dialog = true;
      continue;
    }
    if (line.trim() === '') {
      if (s.dropping) s.dropping = false;
      else if (s.cur) append('');
      continue;
    }
    // A result row is never a summary's or recap's wrapped tail: let it
    // through — unless it is chrome (`⎿ Tip:`), which stays dropped along
    // with its own wrapped tail.
    if (s.dropping) { if (CONTINUATION_RE.test(line) && (!RESULT_RE.test(line) || isChrome(line))) continue; s.dropping = false; }
    // A choice box's key-hint footer is chrome even when it sits outside the
    // box's own frame — but only between blocks: a prose row that happens to
    // start with the same words is kept.
    if (isDivider(line) || isChrome(line) || (DIALOG_CLOSE_RE.test(line) && !s.cur)) continue;

    let m: RegExpExecArray | null;
    if (RECAP_RE.test(line)) { s.dropping = true; s.cur = null; continue; }
    if (SUMMARY_RE.test(line)) {
      if (isSpinner(line)) s.spinner = line.trim();
      s.cur = null;            // a turn summary closes the block before it
      s.dropping = true;       // in a narrow pane the summary wraps; its tail is not prose
      continue;
    }
    if ((m = PROMPT_RE.exec(line)) && !CONTINUATION_RE.test(line) && !OPTION_RE.test(line)) {
      push({ kind: 'you', text: m[1].trim() });
      head(line, m[1]);
      continue;
    }
    if ((m = AGENT_RE.exec(line))) {
      push({ kind: 'agent', text: m[1].trim() });
      head(line, m[1]);
      continue;
    }
    if ((m = RESULT_RE.exec(line))) {
      if (!s.cur || s.cur.kind === 'you' || s.cur.kind === 'system') {
        push({ kind: 'tool', text: '', partial: !s.cur });
      }
      const cur = s.cur as Block;
      cur.kind = 'tool';
      s.inResult = true;
      cur.result = cur.result ? `${cur.result}\n${m[1].trimEnd()}` : m[1].trimEnd();
      continue;
    }
    if (CONTINUATION_RE.test(line)) {
      if (!s.cur) { push({ kind: 'agent', text: '', partial: true }); s.baseIndent = line.length - line.trimStart().length; }
      if (s.inResult) append(line.trim());           // tool output keeps its rows
      else appendWrapped(s.cur as Block, s, line, width);
      s.prevLen = line.length;
      s.prevIndent = line.length - line.trimStart().length;
      continue;
    }
    // Unindented, unmarked: shell banner / MOTD before the CLI started.
    if (s.cur?.kind === 'system') append(line.trim());
    else push({ kind: 'system', text: line.trim() });
  }

  const tidy = blocks
    .map(b => ({ ...b, text: b.text.replace(/\n{3,}/g, '\n\n').trim(), result: b.result?.replace(/\n{3,}/g, '\n\n').trim() }))
    .filter(b => b.text.length > 0 || (b.result && b.result.length > 0));
  return { blocks: tidy, spinner: s.spinner };
}

// ── pi ───────────────────────────────────────────────────────
//
// Read off live captures of pi's default dark theme (2026-10-09). pi prints
// no turn markers; what tells its parts apart is styling, and the background
// carries from one row to the next until pi resets it:
//
//   your message    rows on the user-message background (256-colour 17)
//   a tool call     a box on another background (16; 52 = the command failed):
//                   a bold header (`$ cmd`, `read <path>`, `edit <path>` …),
//                   output rows, and a `Took 0.6s` footer
//   reasoning       grey italic rows, bullets and numbers in an accent colour
//   the answer      everything else
//   editor + footer the last two divider rows frame the editor (its text is the
//                   draft, or a picker such as /model); after them sit the cwd
//                   and token-stats rows, which are chrome
//
// If the theme changes the colours, rows simply fall to "the answer": still
// readable, never muted.

const PI_USER_BG = '17';
const PI_ERROR_BG = '52';
// Built-in tool headers. Only used to spot a new box that starts while the
// previous one never printed its footer; the first bold row of a fresh box is
// its header whatever the tool is called (extension and MCP tools too).
const PI_TOOL_HEADER_RE = /^(?:\$\s|(?:read|edit|write|ls|find|grep|bash)\s)/;
// A whole-row duration: "Took 0.6s", "Took 42ms", "Took 1m 23s".
const PI_TOOK_RE = /^\s*Took \d+(?:\.\d+)?(?:ms|s|m|h)(?:\s+\d+(?:\.\d+)?(?:ms|s|m|h))*\s*$/;
// pi's footer below the editor: the cwd row, the token-stats row, and an
// extension status row. More rows than this after the last divider pair
// means pi is not the live screen (it exited, or the pair is old scrollback).
const PI_MAX_FOOTER_ROWS = 3;
const PI_OVERLAY_RE = /Enter to select|Escape\/Ctrl\+C to cancel|Esc to cancel/;

export interface StyledRow {
  /** The row without escapes, trailing spaces trimmed. */
  text: string;
  /** Background in effect at the first visible character (256-colour index or r:g:b), null = default. */
  bg: string | null;
  /** Share of the row's visible characters drawn italic / bold. */
  italic: number;
  bold: number;
  /** The first visible character is bold (pi's tool headers: `read` bold, then the path in an accent colour). */
  boldStart: boolean;
}

/** Tracks SGR state across rows, the way tmux `capture-pane -e` emits it. */
export function scanStyled(lines: string[]): StyledRow[] {
  const st = { bg: null as string | null, italic: false, bold: false };
  const apply = (params: string) => {
    const ps = params === '' ? ['0'] : params.split(';');
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      if (p === '' || p === '0') { st.bg = null; st.italic = false; st.bold = false; }
      else if (p === '1') st.bold = true;
      else if (p === '22') st.bold = false;
      else if (p === '3') st.italic = true;
      else if (p === '23') st.italic = false;
      else if (p === '49') st.bg = null;
      else if (p === '38' || p === '48') {
        let v: string | null = null;
        if (ps[i + 1] === '5') { v = ps[i + 2] ?? null; i += 2; }
        else if (ps[i + 1] === '2') { v = ps.slice(i + 2, i + 5).join(':'); i += 4; }
        if (p === '48') st.bg = v;
      } else if (/^4[0-7]$|^10[0-7]$/.test(p)) st.bg = p;
    }
  };
  // eslint-disable-next-line no-control-regex
  const TOKEN = /\x1b\[([0-9;?]*)([ -/]*[@-~])/g;
  return lines.map(line => {
    let text = ''; let first: string | null | undefined; let boldStart = false; let visible = 0; let it = 0; let bd = 0;
    const take = (seg: string) => {
      for (const ch of seg) {
        text += ch;
        if (ch.trim() === '') continue;
        if (first === undefined) { first = st.bg; boldStart = st.bold; }
        visible++; if (st.italic) it++; if (st.bold) bd++;
      }
    };
    let pos = 0;
    for (const m of line.matchAll(TOKEN)) {
      take(line.slice(pos, m.index));
      pos = (m.index ?? 0) + m[0].length;
      if (m[2] === 'm') apply(m[1]);
    }
    take(line.slice(pos));
    return { text: text.trimEnd(), bg: first ?? null, italic: visible ? it / visible : 0, bold: visible ? bd / visible : 0, boldStart };
  });
}

function parsePi(lines: string[]): ParsedPane {
  const rows = scanStyled(lines);
  // Editor and footer: the last two dividers, if they really frame pi's
  // live editor. A divider on a tool box's background is command output, not
  // a frame. And the pair must be followed by pi's short footer: when pi has
  // exited, or the pair is old scrollback, rows below it are live content and
  // the whole pane is transcript.
  const div = rows.map((r, i) => (isDivider(r.text) && r.bg === null ? i : -1)).filter(i => i >= 0);
  let bodyEnd = rows.length;
  let draft: string | null = null;
  const tail: Block[] = [];
  const footerRows = div.length >= 2 ? rows.slice(div[div.length - 1] + 1).filter(r => r.text.trim()).length : Infinity;
  if (div.length >= 2 && footerRows <= PI_MAX_FOOTER_ROWS) {
    const top = div[div.length - 2], bottom = div[div.length - 1];
    bodyEnd = top;
    const editorStyled = lines.slice(top + 1, bottom);
    const editor = rows.slice(top + 1, bottom).map(r => r.text);
    if (editor.some(t => PI_OVERLAY_RE.test(t))) {
      // A picker (/model, a question) is drawn where the editor sits.
      const text = editor.join('\n').replace(/\n{3,}/g, '\n\n').trim();
      if (text) tail.push({ kind: 'dialog', text, options: 0 });
    } else {
      draft = editorStyled
        .filter(l => !DIM_RE.test(l))
        .map(l => { const t = stripSgr(l).trimEnd(); const m = PROMPT_RE.exec(t.trimStart()); return (m ? m[1] : t).trim(); })
        .filter(Boolean).join('\n');
    }
  }
  const width = div.reduce((w, i) => Math.max(w, rows[i].text.length), 0);

  const blocks: Block[] = [];
  // Mutable cursor in an object, as in parseTurns: TypeScript cannot see
  // assignments made inside the helper closures below.
  const c = { cur: null as Block | null, phase: 'done' as 'head' | 'out' | 'done', prevRowLen: 0 };
  const wrap: WrapState = { prevLen: 0, prevIndent: 0, baseIndent: 0, inFence: false };
  const push = (b: Block, row?: StyledRow) => {
    c.cur = b; blocks.push(b); wrap.inFence = false;
    if (row) { wrap.prevLen = row.text.length; wrap.prevIndent = wrap.baseIndent = row.text.length - row.text.trimStart().length; }
  };
  const prose = (kind: 'agent' | 'thinking' | 'you', row: StyledRow) => {
    if (c.cur?.kind === kind) {
      appendWrapped(c.cur, wrap, row.text, width);
      wrap.prevLen = row.text.length; wrap.prevIndent = row.text.length - row.text.trimStart().length;
    } else {
      push({ kind, text: row.text.trim() }, row);
    }
  };

  for (const row of rows.slice(0, bodyEnd)) {
    const t = row.text;
    if (t.trim() === '') {
      if (c.cur && c.cur.kind !== 'tool') c.cur.text += '\n';     // a paragraph break, tidied below
      else if (c.cur?.kind === 'tool' && c.phase === 'out') c.cur.result = (c.cur.result ?? '') + '\n';
      // A tool box's header rows are followed by one blank row before any
      // output: the blank ends the header.
      else if (c.cur?.kind === 'tool' && c.phase === 'head') c.phase = 'out';
      continue;
    }
    const inBox = row.bg !== null && row.bg !== PI_USER_BG;
    if (!inBox && isDivider(t)) continue;               // a rule in tool output is output
    if (row.bg === PI_USER_BG) { c.phase = 'done'; prose('you', row); continue; }
    if (inBox || (c.cur?.kind === 'tool' && c.phase !== 'done' && PI_TOOK_RE.test(t))) {
      if (PI_TOOK_RE.test(t)) { if (c.cur?.kind === 'tool') c.phase = 'done'; continue; }
      const fresh = c.cur?.kind !== 'tool' || c.phase === 'done';
      const header = row.boldStart && (fresh || PI_TOOL_HEADER_RE.test(t.trimStart()));
      if (header || fresh) {
        if (header) { push({ kind: 'tool', text: t.trim(), failed: row.bg === PI_ERROR_BG || undefined }); c.prevRowLen = t.length; }
        else push({ kind: 'tool', text: '', partial: true, result: t.trim(), failed: row.bg === PI_ERROR_BG || undefined });
        c.phase = header ? 'head' : 'out';
        continue;
      }
      const tool = c.cur as Block;
      if (row.bg === PI_ERROR_BG) tool.failed = true;
      // Header rows run until the box's first blank row, and only while the
      // row above reached the box edge (a short row cannot have wrapped). Not
      // "bold rows": a `read|edit|…` header is bold only in its first word,
      // and its path (upright, in an accent colour) can wrap too.
      if (c.phase === 'head' && (width <= 0 || c.prevRowLen >= width - 2)) {
        // The command continues on the next row. pi cuts a long command at
        // the box edge and resumes further on, so a row that ran to the edge
        // lost text: say so with an ellipsis rather than gluing two fragments.
        const prevRow = c.prevRowLen;
        tool.text += (width > 0 && prevRow >= width - 2 ? ' … ' : ' ') + t.trim();
        c.prevRowLen = t.length;
        continue;
      }
      c.phase = 'out';
      tool.result = tool.result ? `${tool.result}\n${t.trim()}` : t.trim();
      continue;
    }
    c.phase = 'done';
    // Reasoning is sticky: a reasoning row with an inline code span (drawn
    // upright, in the accent colour) is still reasoning. A row starts
    // reasoning when most of it is italic, and leaves it when none of it is.
    const thinking = c.cur?.kind === 'thinking' ? row.italic > 0 : row.italic >= 0.5;
    prose(thinking ? 'thinking' : 'agent', row);
  }

  const tidy = (s: string | undefined) => s?.replace(/\n{3,}/g, '\n\n').trim();
  const kept = blocks
    .map(b => ({ ...b, text: tidy(b.text) ?? '', result: tidy(b.result) }))
    .filter(b => b.text.length > 0 || (b.result && b.result.length > 0));
  // Grammar missed everything in the transcript (a new pi build?): show the
  // transcript's text rather than nothing. Only the part above the editor —
  // an empty session is a correct empty transcript, not a miss, and the cwd /
  // token rows below the editor are chrome either way.
  const body = rows.slice(0, bodyEnd).filter(r => !isDivider(r.text)).map(r => r.text);
  if (kept.length === 0 && body.some(t => t.trim())) {
    kept.push({ kind: 'plain', text: body.join('\n').replace(/\n{3,}/g, '\n\n').trim(), result: undefined });
  }
  return { mode: 'pi', blocks: [...kept, ...tail.map(b => ({ ...b, text: tidy(b.text) ?? '' }))], draft, spinner: null };
}

/**
 * Splits block text into prose and ``` fenced code, so a renderer can show
 * code monospace with its rows intact and prose in the reading font. The
 * fence rows themselves (and their language tag) are dropped.
 */
export function splitFences(text: string): Array<{ code: boolean; text: string }> {
  const out: Array<{ code: boolean; text: string }> = [];
  let buf: string[] = [];
  let code = false;
  const flush = () => { if (buf.some(l => l.trim())) out.push({ code, text: code ? buf.join('\n') : buf.join('\n').trim() }); buf = []; };
  for (const line of text.split('\n')) {
    if (FENCE_RE.test(line)) { flush(); code = !code; continue; }
    buf.push(line);
  }
  flush();
  return out;
}

// ── Entry point ────────────────────────────────────────────────────────────

export function parsePane(raw: string, opts: ParseOptions): ParsedPane {
  const mode = chatMode(opts.provider, opts.role);
  const lines = (raw ?? '').replace(/\r\n?/g, '\n').split('\n');
  // Trailing blank rows are the unused bottom of the pane, not content.
  while (lines.length > 0 && stripSgr(lines[lines.length - 1]).trim() === '') lines.pop();

  if (mode === 'pi') return parsePi(lines);

  if (mode === 'plain') {
    // The ctrl shell has no input box; agent CLIs (and Devin in the review pane) do.
    const split = opts.role !== 'ctrl' ? splitInputBox(lines) : { body: lines.map(stripSgr), draft: null, footer: [] };
    const text = split.body.map(l => l.trimEnd()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
    return {
      mode,
      blocks: text ? [{ kind: 'plain', text }] : [],
      draft: split.draft,
      spinner: null,
    };
  }

  const split = splitInputBox(lines);
  // Pane width: the input-box and dialog dividers are drawn at the CURRENT
  // width, so they are the measure; rows from before a resize may be wider.
  // With no divider in view the width is unknown and nothing is rejoined.
  const dividers = lines.map(l => stripSgr(l).trimEnd()).filter(isDivider);
  const width = dividers.reduce((w, d) => Math.max(w, d.length), 0);
  const { blocks, spinner } = parseTurns(split.body, width);
  if (blocks.length === 0 && split.body.some(l => l.trim())) {
    // Grammar missed everything (a new CLI build?): show the text rather than nothing.
    return { mode, blocks: [{ kind: 'plain', text: split.body.join('\n').trim() }], draft: split.draft, spinner };
  }
  return { mode, blocks, draft: split.draft, spinner };
}
