// One set of words: every status a
// person reads leads with Working, Needs you, Idle or Not running, and that
// word agrees with the row's mark. Each row of the spec's mapping table is a
// case here.
import { describe, expect, it } from 'vitest';
import { asDetail, DONE_YOUR_TURN, leadWord, rowStatusText, STATUS_WORDS, statusText, statusWordFor } from './statusWords';
import { chatStatus, desktopTurnStatus, emptyChat, type ChatItem, type ChatState } from './sdkChat';
import { sidebarLine, statusLine, type StatusLineInput } from './simpleChat';
import { chatRowState, type RowStateKind } from './rowState';
import { statusLabel, waitingLabel, type InboxRow } from '../mobile/inbox';
import { continuationStatus } from './continuation';
import { TERMINAL_HOLD_VIEW } from './terminalHold';
import type { ChatLiveStatus } from './chatLiveStatus';

function row(over: Partial<InboxRow> = {}): InboxRow {
  return { status: 'idle', waitingReason: null, band: 'other', ring: null, review: null, message: null, ...over } as InboxRow;
}
const review = (pr: number) => ({ pr } as InboxRow['review']);
const chat = (over: Partial<ChatState>): ChatState => ({ ...emptyChat, ...over });
const item = (it: Record<string, unknown>) => it as unknown as ChatItem;
const ended = (last: Record<string, unknown>) => chat({ items: [item({ kind: 'user', key: 'u1', text: 'hi' }), item({ key: 'x', ...last })] });
const tasks = (n: number, subagent = false) => Array.from({ length: n }, (_, i) => ({ id: `t${i}`, subagent })) as unknown as ChatState['background'];

describe('the four words', () => {
  it('has one word per mark', () => {
    const kinds: RowStateKind[] = ['working', 'approval', 'unread', 'error', 'done', 'off'];
    expect(kinds.map(statusWordFor)).toEqual(['Working', 'Needs you', 'Needs you', 'Needs you', 'Idle', 'Not running']);
    expect(new Set(kinds.map(statusWordFor))).toEqual(new Set(STATUS_WORDS));
  });

  it('composes the word and why, and reads the word back', () => {
    expect(statusText('Idle')).toBe('Idle');
    expect(statusText('Needs you', 'approval')).toBe('Needs you · approval');
    expect(statusText('Working', '  ')).toBe('Working');
    expect(leadWord('Needs you · approval')).toBe('Needs you');
    expect(leadWord('Not running')).toBe('Not running');
    expect(leadWord('Ready')).toBeNull();
    expect(leadWord('Idleness · x')).toBeNull();
    expect(asDetail('Thinking…')).toBe('thinking…');
  });

  it('says a plain finished turn as "Idle" in the header and the sidebar, "Idle · your turn" under the transcript', () => {
    expect(DONE_YOUR_TURN).toBe('Idle · your turn');
    expect(rowStatusText(DONE_YOUR_TURN)).toBe('Idle');
    expect(rowStatusText('Idle · stopped')).toBe('Idle · stopped');
  });
});

describe("today's words, and what they become", () => {
  it('rows on /m and the chat sidebar (statusLabel, waitingLabel)', () => {
    expect(statusLabel(row({ status: 'working' }))).toBe('Working');
    expect(statusLabel(row({ status: 'idle' }))).toBe('Idle');
    expect(statusLabel(row({ status: 'not_running' }))).toBe('Not running');
    expect(waitingLabel('approval')).toBe('Needs you · approval');
    expect(waitingLabel('user_input')).toBe('Needs you · a question');
    expect(waitingLabel('unknown')).toBe('Needs you');
    expect(waitingLabel(null)).toBe('Needs you');
    expect(statusLabel(row({ ring: 'waiting' }))).toBe('Needs you · Devin');
    expect(statusLabel(row({ ring: 'done', review: review(12) }))).toBe('Needs you · review #12 ready');
    expect(statusLabel(row({ ring: 'reviewing', review: review(12) }))).toBe('Working · reviewing #12');
  });

  it('the sidebar while the box or clone comes up (sidebarLine), and the pane chat\'s line (statusLine)', () => {
    expect(sidebarLine(row({ status: 'not_running' }), undefined, 'pending').state).toBe('Working · setting up');
    expect(sidebarLine(row({ status: 'not_running' }), undefined, 'cloning').state).toBe('Working · setting up');
    expect(statusLine({ status: undefined, setupLabel: 'cloning' }).text).toBe('Working · setting up · cloning');
    expect(statusLine({ status: 'working', message: 'Bash · npm test' }).text).toBe('Working · Bash · npm test');
    expect(statusLine({ status: 'working', spinner: '✻ Thinking… (3s)' }).text).toBe('Working · thinking… (3s)');
    expect(statusLine({ status: 'idle' }).text).toBe('Idle · your turn');
    expect(statusLine({ status: 'not_running' }).text).toBe('Not running');
    expect(statusLine({ status: 'working', offline: true }).text).toBe('Not running · box offline, showing the last capture');
  });

  it('the SDK chat\'s line (chatStatus)', () => {
    expect(chatStatus(chat({ running: true, phase: 'tool', activeTool: { name: 'Bash', input: { command: 'npm test' } } })).text).toBe('Working · Bash · npm test');
    expect(chatStatus(chat({ running: true, phase: 'thinking' as ChatState['phase'] })).text).toBe('Working · thinking…');
    expect(chatStatus(chat({ running: true, phase: 'writing' })).text).toBe('Working · writing…');
    expect(chatStatus(chat({ running: true, phase: 'compacting' })).text).toBe('Working · compacting…');
    expect(chatStatus(chat({ items: [item({ kind: 'user', key: 'u1', text: 'hi', pending: true })] })).text).toBe('Working · sending…');
    expect(chatStatus(chat({ running: true, woken: true })).text).toBe('Working · background task finished');
    expect(chatStatus(ended({ kind: 'assistant', text: 'All green' }))).toEqual({ tone: 'idle', text: 'Idle · your turn' });
    expect(chatStatus(ended({ kind: 'error', text: 'boom' }))).toEqual({ tone: 'error', text: 'Needs you · failed' });
    expect(chatStatus(ended({ kind: 'note', text: 'Stopped by you' })).text).toBe('Idle · stopped');
    expect(chatStatus(ended({ kind: 'divider' })).text).toBe('Idle · context cleared');
    expect(chatStatus(ended({ kind: 'divider', variant: 'compacted' })).text).toBe('Idle · context compacted');
    expect(chatStatus(ended({ kind: 'divider', undone: true })).text).toBe('Idle · context resumed');
    const waiting = chat({ running: true, phase: 'waiting', liveTurn: true, background: tasks(2, true) });
    expect(chatStatus(waiting, true).text).toBe('Idle · 2 agents still running');
    expect(chatStatus(waiting, false).text).toBe('Idle · 2 agents still running · a message waits until they end');
    expect(chatStatus(chat({ running: true, phase: 'waiting', background: tasks(1) }), false).text)
      .toBe('Idle · 1 background task still running · a message waits until it ends');
    expect(chatStatus(emptyChat).text).toBe('Idle · no messages yet');
  });

  it('the desktop app\'s turn (desktopTurnStatus)', () => {
    expect(desktopTurnStatus({ status: 'working', source: 't3:claude' })?.text).toBe('Working · in the desktop app');
    expect(desktopTurnStatus({ status: 'waiting', source: 't3:claude' })?.text).toBe('Needs you · in the desktop app');
  });

  it('an unseen row keeps its own word, with " · unread"', () => {
    expect(chatRowState(row(), undefined, null, true).text).toBe('Idle · unread');
    expect(chatRowState(row({ status: 'not_running' }), undefined, null, true).text).toBe('Not running · unread');
  });

  it('the lines a chat shows while it comes back or is held', () => {
    expect(continuationStatus({ phase: 'starting' })?.text).toBe('Working · starting the box…');
    expect(TERMINAL_HOLD_VIEW.statusText).toBe('Idle · open in Lab');
  });
});

describe('the word and the mark never disagree', () => {
  const live = (l: { tone: ChatLiveStatus['tone']; text: string }): ChatLiveStatus => ({ ...l, preview: null });
  const agrees = (text: string, kind: RowStateKind) => expect([text, leadWord(text)]).toEqual([text, statusWordFor(kind)]);

  it('for every row the status pipeline gives', () => {
    const rows: InboxRow[] = [
      row({ status: 'working', band: 'running' }),
      row({ status: 'waiting', waitingReason: 'approval', band: 'attention' }),
      row({ status: 'waiting', waitingReason: 'user_input', band: 'attention' }),
      row({ status: 'waiting', band: 'attention' }),
      row({ ring: 'waiting', band: 'attention' }),
      row({ ring: 'done', band: 'attention', review: review(3) }),
      row({ status: 'working', ring: 'done', band: 'attention', review: review(3) }),
      row({ ring: 'reviewing', band: 'reviewing', review: review(3) }),
      row({ status: 'idle' }),
      row({ status: 'not_running' }),
    ];
    for (const r of rows) {
      for (const unseen of [false, true]) {
        const s = chatRowState(r, undefined, null, unseen);
        agrees(s.text, s.kind);
        expect(leadWord(statusLabel(r))).toBe(statusWordFor(s.kind));
      }
    }
    const settingUp = chatRowState(row({ status: 'not_running' }), undefined, 'cloning');
    agrees(settingUp.text, settingUp.kind);
  });

  it('for every line an open SDK chat publishes', () => {
    const lines = [
      chatStatus(chat({ running: true, phase: 'writing' })),
      chatStatus(chat({ running: true, phase: 'tool', activeTool: { name: 'Read', input: { file_path: '/a' } } })),
      chatStatus(ended({ kind: 'assistant', text: 'ok' })),
      chatStatus(ended({ kind: 'error', text: 'boom' })),
      chatStatus(ended({ kind: 'note', text: 'Stopped by you' })),
      chatStatus(chat({ running: true, phase: 'waiting', background: tasks(2) }), true),
      chatStatus(emptyChat),
      desktopTurnStatus({ status: 'working', source: 't3:claude' })!,
      continuationStatus({ phase: 'restoring' })!,
      { tone: 'off' as const, text: statusText('Not running', 'box is stopped, sending a message starts it') },
      { tone: 'idle' as const, text: TERMINAL_HOLD_VIEW.statusText },
    ];
    for (const l of lines) {
      const s = chatRowState(row(), live(l), null);
      expect(leadWord(l.text)).toBe(statusWordFor(s.kind));
      agrees(s.text, s.kind);
    }
  });

  it('for the desktop app waiting on you: the chat publishes nothing, so its row reads the pipeline', () => {
    const line = desktopTurnStatus({ status: 'waiting', source: 't3:claude' })!;
    expect(line.tone).toBe('working');
    const s = chatRowState(row({ status: 'waiting', waitingReason: 'approval', band: 'attention' }), undefined, null);
    expect(leadWord(line.text)).toBe(statusWordFor(s.kind));
  });

  it('for every line under the pane chat\'s transcript and its row', () => {
    const cases: Array<[StatusLineInput, InboxRow, string | null]> = [
      [{ status: 'working', message: 'Bash' }, row({ status: 'working', band: 'running' }), null],
      [{ status: 'waiting', waitingReason: 'approval' }, row({ status: 'waiting', waitingReason: 'approval', band: 'attention' }), null],
      [{ status: 'idle' }, row({ status: 'idle' }), null],
      [{ status: 'not_running' }, row({ status: 'not_running' }), null],
      [{ status: 'not_running', setupLabel: 'cloning' }, row({ status: 'not_running' }), 'cloning'],
    ];
    for (const [input, r, setup] of cases) {
      expect(leadWord(statusLine(input).text)).toBe(statusWordFor(chatRowState(r, undefined, setup).kind));
    }
  });
});
