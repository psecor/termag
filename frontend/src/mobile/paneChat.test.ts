import { describe, it, expect } from 'vitest';
import { chatMode, parsePane, scanStyled, splitFences, stripSgr } from './paneChat';

const ESC = '\x1b';
const DIV = '─'.repeat(100) + '�'; // tmux cuts the last glyph at the pane edge; spans the (wide) pane

// Claude Code, mid-turn: a shell banner, a user prompt, prose, a tool call
// with its result, a turn summary, a new prompt, a running tool, the spinner,
// a tip, and an empty input box with the mode footer. Shape taken from a
// styled capture of a live session (docs/mobile.md §8).
const CLAUDE_WORKING = [
  '',
  'Welcome to your termag box.',
  '',
  '  Run `termag doctor` to be walked through it.',
  '',
  '❯ Commit the doc and start on phase 1a',
  '',
  '● Committing the doc first, then I will read the pieces of the frontend I need.',
  '',
  '● Install pre-commit if needed and commit the design doc',
  '  ⎿  $ git add docs/mobile.md && git commit -q -m "docs(mobile): design"',
  '     1d8a6a4 docs(mobile): design for the phone client at /termag/m',
  '',
  '  Ran 1 shell command',
  '',
  '● Done. The doc now reflects all three answers.',
  '',
  '  Recents is a fourth inbox group below Needs you, Working and Idle.',
  '  Collaborators are out.',
  '',
  '✻ Crunched for 45s · done 4:36 AM',
  '',
  '❯ now the parser',
  '',
  '● Capturing tmux pane fixtures from live sessions',
  '  ⎿  $ tmux capture-pane -p -e -S -400 -t psecor-termag-agent',
  '',
  '✻ Channeling… (1m 17s · ↓ 3.5k tokens)',
  '  ⎿  Tip: Run /team-onboarding to turn your Claude usage into an onboarding guide',
  '',
  DIV,
  '❯ ',
  DIV,
  '  ⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt · ← for agents',
].join('\n');

// Claude Code, idle, with a recap and a typed-but-unsent draft in the box.
const CLAUDE_IDLE_DRAFT = [
  '  Two of your worktrees have directory names that do not match their branches:',
  '  - .worktrees/termag-tui is on branch termag-tui-phase3',
  '',
  '  If you want them to match, git worktree move renames a directory.',
  '',
  '✻ Baked for 1d 4h 1m · done 7:53 PM',
  '',
  '※ recap: You are tidying up your box setup, and I just answered your question',
  '  about worktree naming. Next, pick how to free Ctrl-K from tmux.',
  '                                            ✔ Update installed · Restart to apply',
  DIV,
  '❯ rename the tui worktrees to match their branches',
  DIV,
  '  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents',
].join('\n');

// Styled: the recap footer is dim, and the input box shows a dimmed
// placeholder, which must NOT be read as a draft.
const CLAUDE_STYLED_PLACEHOLDER = [
  `${ESC}[1m● Done.${ESC}[0m`,
  `  ${ESC}[3m${ESC}[38;5;246m(disable recaps in /config)${ESC}[0m`,
  `${ESC}[38;5;244m${DIV}`,
  `${ESC}[39m❯ ${ESC}[38;5;244mTry "fix the failing test"${ESC}[39m`,
  `${ESC}[38;5;244m${DIV}`,
  `${ESC}[39m  ${ESC}[38;5;220m⏵⏵ auto mode on${ESC}[38;5;246m (shift+tab to cycle)${ESC}[39m`,
].join('\n');

// Devin: prose, an input box with the ❭ prompt and a dimmed placeholder, a model footer.
const DEVIN = [
  ' Verdict',
  '',
  ' Approve with nits. Nothing here blocks merge.',
  '',
  DIV,
  `❭ ${ESC}[2mAsk Devin to build features, fix bugs, or work on your code${ESC}[22m`,
  DIV,
  'SWE-2 High                                  Context: 114k / 262k tokens (43%',
].join('\n');

// Claude Code asking a multiple-choice question (AskUserQuestion): the box is
// framed by dividers like the input box, the highlighted option carries ❯,
// and the footer says how to answer. Taken from a live capture.
const CLAUDE_DIALOG = [
  '● I stopped before rebuilding the staging branch. The stack cannot merge as it stands.',
  '',
  '  Staging follows trivially once that exists, since the stage base is main.',
  DIV,
  ' ☐ Direction ',
  '',
  '│ Main now carries a CLI auth that supersedes phase 1 and conflicts with phases 2',
  '│ and 3. How do you want to proceed?',
  '',
  '❯ 1. Re-target onto the CLI auth (Recommended)',
  '     Close #173. Rebuild remote attach on top of the CLI.',
  '  2. Rebase the stack as-is',
  '     Keep both auth paths side by side.',
  '  3. Pause and talk to the author first',
  '  4. Stage only, no merge yet',
  '  5. Type something.',
  DIV,
  '  6. Chat about this',
  '',
  'Enter to select · ↑/↓ to navigate · Esc to cancel',
  '',
].join('\n');

const CTRL = [
  '➜  termag git:(main) pwd',
  '/home/user/termag/projects/termag',
  '➜  termag git:(main)',
  '',
  '',
].join('\n');

describe('chatMode', () => {
  it('gives Claude turns and everything else plain', () => {
    expect(chatMode('claude', 'agent')).toBe('turns');
    expect(chatMode('devin', 'agent')).toBe('plain');
    expect(chatMode('claude', 'ctrl')).toBe('plain');
    expect(chatMode(null, 'agent')).toBe('plain');
  });
});

describe('stripSgr', () => {
  it('removes colour and style sequences', () => {
    expect(stripSgr(`${ESC}[1m${ESC}[38;5;246mhi${ESC}[0m`)).toBe('hi');
  });
});

describe('parsePane · Claude turns', () => {
  const p = parsePane(CLAUDE_WORKING, { provider: 'claude', role: 'agent' });

  it('splits the pane into you / agent / tool blocks in order', () => {
    expect(p.mode).toBe('turns');
    expect(p.blocks.map(b => b.kind)).toEqual([
      'system', 'you', 'agent', 'tool', 'agent', 'you', 'tool',
    ]);
  });

  it('keeps the banner as a system block', () => {
    expect(p.blocks[0].text).toContain('Welcome to your termag box.');
    expect(p.blocks[0].text).toContain('Run `termag doctor`');
  });

  it('reads the user prompt without its marker', () => {
    expect(p.blocks[1]).toEqual({ kind: 'you', text: 'Commit the doc and start on phase 1a' });
  });

  it('attaches ⎿ lines and their indented continuation to the tool block', () => {
    const tool = p.blocks[3];
    expect(tool.kind).toBe('tool');
    expect(tool.text).toBe('Install pre-commit if needed and commit the design doc');
    expect(tool.result).toContain('$ git add docs/mobile.md');
    expect(tool.result).toContain('1d8a6a4 docs(mobile)');
    expect(tool.result).toContain('Ran 1 shell command');
  });

  it('joins prose paragraphs into one agent block', () => {
    const agent = p.blocks[4];
    expect(agent.text.split('\n\n')).toHaveLength(2);
    expect(agent.text).toMatch(/^Done\. The doc now reflects/);
    expect(agent.text).toContain('Collaborators are out.');
  });

  it('drops turn summaries, tips and the mode footer', () => {
    const all = p.blocks.map(b => `${b.text}\n${b.result ?? ''}`).join('\n');
    expect(all).not.toContain('Crunched for');
    expect(all).not.toContain('Tip:');
    expect(all).not.toContain('auto mode on');
  });

  it('surfaces the live spinner and an empty draft', () => {
    expect(p.spinner).toBe('✻ Channeling… (1m 17s · ↓ 3.5k tokens)');
    expect(p.draft).toBe('');
  });
});

describe('parsePane · Claude idle with a draft', () => {
  const p = parsePane(CLAUDE_IDLE_DRAFT, { provider: 'claude', role: 'agent' });

  it('treats a capture that starts mid-block as a partial agent block', () => {
    expect(p.blocks[0].kind).toBe('agent');
    expect(p.blocks[0].partial).toBe(true);
    expect(p.blocks[0].text).toContain('Two of your worktrees');
  });

  it('drops the recap and its continuation, and the update banner', () => {
    const all = p.blocks.map(b => b.text).join('\n');
    expect(all).not.toContain('recap:');
    expect(all).not.toContain('free Ctrl-K');
    expect(all).not.toContain('Update installed');
  });

  it('reads the unsent prompt out of the input box', () => {
    expect(p.draft).toBe('rename the tui worktrees to match their branches');
    expect(p.blocks.map(b => b.kind)).not.toContain('you');
  });
});

describe('parsePane · styled input', () => {
  it('ignores a dimmed placeholder in the box and strips SGR from blocks', () => {
    const p = parsePane(CLAUDE_STYLED_PLACEHOLDER, { provider: 'claude', role: 'agent' });
    expect(p.draft).toBe('');
    expect(p.blocks).toEqual([{ kind: 'agent', text: 'Done.' }]);
  });
});

describe('parsePane · Claude question dialog', () => {
  const p = parsePane(CLAUDE_DIALOG, { provider: 'claude', role: 'agent' });

  it('keeps the dialog as one block after the prose, not as a user turn', () => {
    expect(p.blocks.map(b => b.kind)).toEqual(['agent', 'dialog']);
  });

  it('counts the numbered options and keeps the highlighted one', () => {
    const d = p.blocks[1];
    expect(d.options).toBe(6);
    expect(d.text).toMatch(/^☐ Direction/);
    expect(d.text).toContain('❯ 1. Re-target onto the CLI auth');
    expect(d.text).toContain('  6. Chat about this');
    expect(d.text).not.toContain('Enter to select');
  });

  it('does not mistake the dialog for an input box', () => {
    expect(p.draft).toBeNull();
  });
});

// The same CLI in a 28-column pane (the desktop UI's agent pane had been
// narrowed): prose is word-wrapped per row, a URL is broken mid-word, and a
// bullet list keeps its rows. Rows copied from a live capture.
const NARROW_DIV = '─'.repeat(28);
const CLAUDE_NARROW = [
  '❯ Add Devin to the diagram',
  '  and the doc',
  '',
  '● Done. Both files now show',
  '  Devin.',
  '',
  '  One gap worth knowing, now',
  '  wider. The live-status',
  '  gap on boxes applies to',
  '  both Cursor and Devin.',
  '',
  '  - Cursor: poller only',
  '  - Devin: poller only',
  '',
  '  Links are unchanged: https',
  '  ://github.com/example-labs',
  '  /termag/blob/termag-diagra',
  '  m/docs/architecture.md and',
  '  the two SVGs beside it.',
  '',
  '✻ Baked for 2m 55s · done',
  '  5:52 PM',
  NARROW_DIV,
  '❯ ',
  NARROW_DIV,
  '  ⏵⏵ auto mode on      · …',
].join('\n');

describe('parsePane · narrow pane', () => {
  const p = parsePane(CLAUDE_NARROW, { provider: 'claude', role: 'agent' });
  const texts = p.blocks.map(b => b.text);

  it('rejoins a prompt wrapped over two rows', () => {
    expect(p.blocks[0]).toMatchObject({ kind: 'you', text: 'Add Devin to the diagram and the doc' });
  });

  it('rejoins wrapped prose into paragraphs and keeps paragraph breaks', () => {
    expect(texts[1]).toContain('Done. Both files now show Devin.\n\nOne gap worth knowing, now wider. The live-status gap on boxes applies to both Cursor and Devin.');
  });

  it('keeps bullet rows as rows', () => {
    expect(texts[1]).toContain('\n\n- Cursor: poller only\n- Devin: poller only\n\n');
  });

  it('glues a URL broken mid-word back together, then resumes spacing', () => {
    expect(texts[1]).toContain('Links are unchanged: https://github.com/example-labs/termag/blob/termag-diagram/docs/architecture.md and the two SVGs beside it.');
  });

  it('still finds the empty input box and the summary', () => {
    expect(p.draft).toBe('');
    expect(p.blocks).toHaveLength(2);
  });

  it('keeps tool result rows that follow a scrolled-off spinner', () => {
    const q = parsePane([
      '✻ Channeling… (1m 17s · ↓',
      '  3.5k tokens)',
      '  ⎿  $ git status --short',
      '     M frontend/src/x.ts',
      NARROW_DIV, '❯ ', NARROW_DIV,
    ].join('\n'), { provider: 'claude', role: 'agent' });
    const tool = q.blocks.find(b => b.kind === 'tool');
    expect(tool?.result).toBe('$ git status --short\nM frontend/src/x.ts');
    expect(q.blocks.map(b => b.text).join('\n')).not.toContain('3.5k tokens');
  });

  it('drops a wrapped Tip after the spinner along with its tail', () => {
    const q = parsePane([
      '● Done.',
      '',
      '✻ Channeling… (1m 17s · ↓',
      '  3.5k tokens)',
      '  ⎿  Tip: Run /team-onboarding',
      '     to turn your Claude usage',
      '     into an onboarding guide',
      NARROW_DIV, '❯ ', NARROW_DIV,
    ].join('\n'), { provider: 'claude', role: 'agent' });
    expect(q.blocks).toEqual([{ kind: 'agent', text: 'Done.', result: undefined }]);
  });

  it('keeps every row inside a markdown fence', () => {
    const q = parsePane([
      '● Here is the change, in two',
      '  statements:',
      '',
      '  ```ts',
      '  const result = compute(a,',
      '  b); const x = 1;',
      '  ```',
      '',
      '  Both run before the loop',
      '  starts.',
      NARROW_DIV, '❯ ', NARROW_DIV,
    ].join('\n'), { provider: 'claude', role: 'agent' });
    expect(q.blocks[0].text).toBe('Here is the change, in two statements:\n\n```ts\nconst result = compute(a,\nb); const x = 1;\n```\n\nBoth run before the loop starts.');
  });

  it('never joins a row to one at a different indent (code rendered without fences, nested lists)', () => {
    const q = parsePane([
      '● The helper reads the flag',
      '  before anything else runs:',
      '    const on = useFlag(KEY,',
      '    false); if (!on) return;',
      '  - first item of a list that',
      '    wraps onto a second row',
      NARROW_DIV, '❯ ', NARROW_DIV,
    ].join('\n'), { provider: 'claude', role: 'agent' });
    // The list item's wrapped second row is indented deeper than the prose, so it is kept as a row too.
    expect(q.blocks[0].text).toBe('The helper reads the flag before anything else runs:\nconst on = useFlag(KEY,\nfalse); if (!on) return;\n- first item of a list that\nwraps onto a second row');
  });

  it('keeps the space between two long words that met at the right edge', () => {
    const q = parsePane([
      '● It was, all told,',
      '  entirely counterproductive',
      '  circumstances arose',
      NARROW_DIV, '❯ ', NARROW_DIV,
    ].join('\n'), { provider: 'claude', role: 'agent' });
    expect(q.blocks[0].text).toBe('It was, all told, entirely counterproductive circumstances arose');
  });

  it('does not rejoin anything when no divider gives the pane width', () => {
    const q = parsePane([
      '● Two deliberately separate',
      '  short lines',
      '  stay apart',
    ].join('\n'), { provider: 'claude', role: 'agent' });
    expect(q.blocks[0].text).toBe('Two deliberately separate\nshort lines\nstay apart');
  });
});

// Claude Code's permission prompt: no ☐ title, a divider above, the options
// with the cursor on one, optionally a footer. Shape from Claude Code 2.x.
const CLAUDE_PERMISSION = [
  '● Let me check the branch state.',
  '',
  '● Bash(git status --short)',
  '  ⎿  Running…',
  '',
  DIV,
  ' Bash command',
  '',
  '   git status --short',
  '   Show working tree status',
  '',
  ' Do you want to proceed?',
  ' ❯ 1. Yes',
  "   2. Yes, and don't ask again for git status commands in /home/psecor/termag",
  '   3. No, and tell Claude what to do differently (esc)',
].join('\n');

describe('parsePane · Claude permission prompt', () => {
  it('becomes a dialog block with its options counted, not muted system text', () => {
    const p = parsePane(CLAUDE_PERMISSION, { provider: 'claude', role: 'agent' });
    expect(p.blocks.map(b => b.kind)).toEqual(['agent', 'tool', 'dialog']);
    const d = p.blocks[2];
    expect(d.options).toBe(3);
    expect(d.text.split('\n')[0]).toBe('Bash command');
    expect(d.text).toContain('Do you want to proceed?');
    expect(d.text).toContain("2. Yes, and don't ask again");
    expect(p.draft).toBeNull();
  });

  it('stops at a closing divider and swallows an Esc footer', () => {
    const withFooter = parsePane([...CLAUDE_PERMISSION.split('\n'), DIV, ' Esc to cancel · Tab to amend'].join('\n'), { provider: 'claude', role: 'agent' });
    expect(withFooter.blocks.map(b => b.kind)).toEqual(['agent', 'tool', 'dialog']);
    expect(withFooter.blocks[2].text).not.toContain('Esc to cancel');
    const footerOnly = parsePane([...CLAUDE_PERMISSION.split('\n'), ' Esc to cancel'].join('\n'), { provider: 'claude', role: 'agent' });
    expect(footerOnly.blocks[2]).toMatchObject({ kind: 'dialog', options: 3 });
  });

  it('leaves a framed numbered list without a highlighted option alone', () => {
    const p = parsePane([
      '● Three steps:',
      DIV,
      ' 1. Pull main',
      ' 2. Rebuild',
      DIV,
      '❯ ',
      DIV,
    ].join('\n'), { provider: 'claude', role: 'agent' });
    expect(p.blocks.some(b => b.kind === 'dialog')).toBe(false);
  });

  it('ends an unterminated stale box at the next turn instead of swallowing the rest', () => {
    const p = parsePane([
      ...CLAUDE_PERMISSION.split('\n'),
      '',
      '● Ran it: the tree is clean.',
      '  ⎿  nothing to commit',
      '',
      '✻ Crunched for 12s · done 4:36 AM',
      '',
      '❯ now push it',
      '',
      '● Pushing.',
    ].join('\n'), { provider: 'claude', role: 'agent' });
    expect(p.blocks.map(b => b.kind)).toEqual(['agent', 'tool', 'dialog', 'tool', 'you', 'agent']);
    const d = p.blocks[2];
    expect(d.options).toBe(3);
    expect(d.text).not.toContain('Ran it');
    expect(p.blocks[3].result).toBe('nothing to commit');
    expect(p.blocks[4].text).toBe('now push it');
  });

  it('keeps a prose row that starts with footer words', () => {
    const p = parsePane([
      '● The picker shows two keys at the bottom:',
      '  Enter to select picks the row, and Esc backs out.',
    ].join('\n'), { provider: 'claude', role: 'agent' });
    expect(p.blocks[0].text).toContain('Enter to select picks the row');
  });

  it('still hands ☐ question boxes to the AskUserQuestion path', () => {
    const p = parsePane(CLAUDE_DIALOG, { provider: 'claude', role: 'agent' });
    const d = p.blocks.find(b => b.kind === 'dialog')!;
    expect(d.text.split('\n')[0]).toBe('☐ Direction');
  });
});

describe('parsePane · plain providers', () => {
  it('renders Devin as one plain block with the box and footer removed', () => {
    const p = parsePane(DEVIN, { provider: 'devin', role: 'agent' });
    expect(p.mode).toBe('plain');
    expect(p.blocks).toHaveLength(1);
    expect(p.blocks[0].kind).toBe('plain');
    expect(p.blocks[0].text).toContain('Approve with nits.');
    expect(p.blocks[0].text).not.toContain('Ask Devin');
    expect(p.blocks[0].text).not.toContain('SWE-2');
    expect(p.draft).toBe('');
  });

  it('treats the review pane like an agent pane: Devin box and footer removed', () => {
    const p = parsePane(DEVIN, { provider: 'devin', role: 'review' });
    expect(p.mode).toBe('plain');
    expect(p.blocks[0].text).toContain('Approve with nits.');
    expect(p.blocks[0].text).not.toContain('Ask Devin');
    expect(p.draft).toBe('');
  });

  it('renders the ctrl shell verbatim with no draft', () => {
    const p = parsePane(CTRL, { provider: 'claude', role: 'ctrl' });
    expect(p.blocks).toEqual([{ kind: 'plain', text: '➜  termag git:(main) pwd\n/home/user/termag/projects/termag\n➜  termag git:(main)' }]);
    expect(p.draft).toBeNull();
  });

  it('falls back to a plain block when the Claude grammar matches nothing', () => {
    const p = parsePane('some unexpected\n  output here\n', { provider: 'claude', role: 'agent' });
    // Unindented text is a system block; indented text alone would be a partial agent block.
    expect(p.blocks.length).toBeGreaterThan(0);
    expect(p.blocks.map(b => b.text).join('\n')).toContain('output here');
  });

  it('returns no blocks for an empty pane', () => {
    expect(parsePane('\n\n', { provider: 'claude', role: 'agent' }).blocks).toEqual([]);
  });
});

// pi, default dark theme. The escape structure is copied from a
// live capture; the words are made up. Backgrounds carry across rows until pi
// resets them: 17 = your message, 16 = a tool box, 52 = a failed tool box.
// tmux emits a reset before the divider: it is never on a box's background.
const PIDIV = `${ESC}[0m${ESC}[38;5;74m` + '─'.repeat(60);
const PI_PANE = [
  `${ESC}[48;5;17m`,
  ' wait until the other branch merges,',
  ' then stage it',
  '',
  '',
  `${ESC}[49m ${ESC}[3m${ESC}[38;5;103mThe user wants to wait. Keep it short and`,
  `${ESC}[0m ${ESC}[3m${ESC}[38;5;103mmention ${ESC}[0m${ESC}[38;5;140mstage.sh add${ESC}[3m${ESC}[38;5;103m for later.${ESC}[0m`,
  '',
  ` ${ESC}[38;5;140m- ${ESC}[3m${ESC}[38;5;103mA bullet in the reasoning${ESC}[0m`,
  '',
  ' Sounds good, holding.',
  '',
  `${ESC}[48;5;16m`,
  ` ${ESC}[1m$ cd /tmp/appxxxxxxxxx && npm test 2>&1 | tail -5 (timeout${ESC}[0m${ESC}[48;5;16m`,  // runs to the box edge, so the next row continues it
  ` ${ESC}[1m180s)${ESC}[0m${ESC}[48;5;16m`,
  '',
  ` ${ESC}[38;5;109mTests  42 passed (42)${ESC}[39m`,
  '',
  ` ${ESC}[38;5;109mTook 0.6s${ESC}[39m`,
  '',
  `${ESC}[48;5;52m`,
  ` ${ESC}[1m$ rg -n "agentProvider" schema.prisma${ESC}[0m${ESC}[48;5;52m`,
  '',
  ` ${ESC}[38;5;109mCommand exited with code 1${ESC}[39m`,
  '',
  ` ${ESC}[38;5;109mTook 0.0s${ESC}[39m`,
  '',
  `${ESC}[48;5;16m`,
  ` ${ESC}[1mread${ESC}[0m${ESC}[48;5;16m ${ESC}[38;5;140m~/app/src/file.tsx`,
  `${ESC}[39m`,
  '',
  `${ESC}[49m ${ESC}[3m${ESC}[38;5;103mThe current code:${ESC}[0m`,
  ` ${ESC}[3m${ESC}[38;5;103m\`\`\`ts${ESC}[0m`,
  ` ${ESC}[3m${ESC}[38;5;103m    const a = 1;${ESC}[0m`,
  ` ${ESC}[3m${ESC}[38;5;103m    const b = 2;${ESC}[0m`,
  ` ${ESC}[3m${ESC}[38;5;103m\`\`\`${ESC}[0m`,
  '',
  ' All green: it builds and the tests pass.',
  '',
  PIDIV,
  ' stage it now',
  PIDIV,
  `${ESC}[38;5;102m~/app (main)${ESC}[39m`,
  `${ESC}[38;5;102m↑65k ↓12k 3.7%/1.0M (auto)            pi/model • medium`,
  `${ESC}[39mtermag ●`,
].join('\n');

describe('parsePane · pi', () => {
  const p = parsePane(PI_PANE, { provider: 'pi', role: 'agent' });
  const kinds = p.blocks.map(b => b.kind);

  it('uses the pi grammar for the agent pane only', () => {
    expect(chatMode('pi', 'agent')).toBe('pi');
    expect(chatMode('pi', 'ctrl')).toBe('plain');
    expect(p.mode).toBe('pi');
  });

  it('reads the block sequence off the styling', () => {
    expect(kinds).toEqual(['you', 'thinking', 'agent', 'tool', 'tool', 'tool', 'thinking', 'agent']);
  });

  it('collects your message from the user-message background', () => {
    expect(p.blocks[0].text).toBe('wait until the other branch merges,\nthen stage it');
  });

  it('keeps reasoning together across an inline code span and a bullet', () => {
    expect(p.blocks[1].text).toContain('mention stage.sh add for later.');
    expect(p.blocks[1].text).toContain('- A bullet in the reasoning');
  });

  it('makes each tool box a tool block: header, wrapped command, output; Took is dropped', () => {
    const [bash, failed, read] = p.blocks.filter(b => b.kind === 'tool');
    expect(bash.text).toBe('$ cd /tmp/appxxxxxxxxx && npm test 2>&1 | tail -5 (timeout … 180s)');
    expect(bash.result).toBe('Tests  42 passed (42)');
    expect(bash.failed).toBeUndefined();
    expect(failed).toMatchObject({ text: '$ rg -n "agentProvider" schema.prisma', result: 'Command exited with code 1', failed: true });
    expect(read.text).toBe('read ~/app/src/file.tsx');
    expect(p.blocks.some(b => /Took \d/.test(b.text + (b.result ?? '')))).toBe(false);
  });

  it('keeps fenced code rows intact inside reasoning', () => {
    const code = p.blocks[6].text;
    expect(code).toContain('```ts\nconst a = 1;\nconst b = 2;\n```');
    expect(splitFences(code)).toEqual([
      { code: false, text: 'The current code:' },
      { code: true, text: 'const a = 1;\nconst b = 2;' },
    ]);
  });

  it('takes the editor between the last two dividers as the draft and drops the footer', () => {
    expect(p.draft).toBe('stage it now');
    const all = p.blocks.map(b => b.text).join('\n');
    expect(all).not.toContain('pi/model');
    expect(all).not.toContain('termag ●');
  });

  it('shows a picker drawn in the editor as a question with no number keys', () => {
    const picker = PI_PANE.replace(' stage it now', [
      '> ',
      '→ ✓ pi/model-a',
      '    bedrock/model-b',
      `${ESC}[38;5;102m  Enter to select · Ctrl+S to set as default · Escape/Ctrl+C to cancel${ESC}[39m`,
    ].join('\n'));
    const q = parsePane(picker, { provider: 'pi', role: 'agent' });
    expect(q.draft).toBeNull();
    const last = q.blocks[q.blocks.length - 1];
    expect(last).toMatchObject({ kind: 'dialog', options: 0 });
    expect(last.text).toContain('pi/model-a');
  });

  it('keeps a wrapped file-tool path in the title, not the result', () => {
    const q = parsePane([
      `${ESC}[48;5;16m`,
      ` ${ESC}[1mread${ESC}[0m${ESC}[48;5;16m ${ESC}[38;5;140m~/app/frontend/src/components/a-rather-long-`,
      ` ${ESC}[38;5;140mdirectory/File.tsx`,
      `${ESC}[39m`,
      '',
      ` ${ESC}[38;5;109m  1  import x from 'y';${ESC}[39m`,
      '',
      `${ESC}[49m Read it.`,
    ].join('\n'), { provider: 'pi', role: 'agent' });
    expect(q.blocks[0].kind).toBe('tool');
    expect(q.blocks[0].text).toBe('read ~/app/frontend/src/components/a-rather-long- directory/File.tsx');
    expect(q.blocks[0].result).toBe("1  import x from 'y';");
  });

  it('shows nothing for an empty session, not the footer chrome', () => {
    const q = parsePane([
      PIDIV,
      '',
      PIDIV,
      `${ESC}[38;5;102m~/app (main)${ESC}[39m`,
      `${ESC}[38;5;102m0.0%/1.0M (auto)            pi/model • medium`,
      `${ESC}[39mtermag ●`,
    ].join('\n'), { provider: 'pi', role: 'agent' });
    expect(q.blocks).toEqual([]);
    expect(q.draft).toBe('');
  });

  it('reads an unstyled transcript row as an answer (the plain fallback is only a safety net)', () => {
    const q = parsePane(['only an unstyled line', PIDIV, '', PIDIV, 'footer'].join('\n'), { provider: 'pi', role: 'agent' });
    expect(q.blocks).toEqual([{ kind: 'agent', text: 'only an unstyled line', result: undefined }]);
  });

  it('does not take a divider pair as the editor when pi is no longer the live screen', () => {
    // pi exited: its last frame stays, and the shell prompt and output follow the footer.
    const exited = [
      ' Done.',
      PIDIV, ' leftover text', PIDIV,
      `${ESC}[38;5;102m~/app (main)${ESC}[39m`,
      `${ESC}[38;5;102m0.0%/1.0M (auto)            pi/model • medium`,
      '$ pi --version',
      '0.9.1',
      '$ ',
    ].join('\n');
    const q = parsePane(exited, { provider: 'pi', role: 'agent' });
    expect(q.draft).toBeNull();
    const all = q.blocks.map(b => b.text).join('\n');
    expect(all).toContain('pi --version');
    expect(all).toContain('0.9.1');
  });

  it('has no draft and keeps every row when there are no dividers at all', () => {
    const q = parsePane([' First answer.', '', ' Second answer.'].join('\n'), { provider: 'pi', role: 'agent' });
    expect(q.draft).toBeNull();
    expect(q.blocks.map(b => b.text)).toEqual(['First answer.\n\nSecond answer.']);
  });

  it('keeps a rule printed by a command as output, and never as the editor frame', () => {
    const q = parsePane([
      `${ESC}[48;5;16m`,
      ` ${ESC}[1m$ make report${ESC}[0m${ESC}[48;5;16m`,
      '',
      ` ${ESC}[38;5;109mbefore${ESC}[39m`,
      ` ${ESC}[38;5;109m${'─'.repeat(30)}${ESC}[39m`,
      ` ${ESC}[38;5;109mafter${ESC}[39m`,
      '',
      ` ${ESC}[38;5;109mTook 42ms${ESC}[39m`,
      '',
      `${ESC}[49m Report printed.`,
      PIDIV, ' next', PIDIV,
      `${ESC}[38;5;102m~/app (main)${ESC}[39m`,
    ].join('\n'), { provider: 'pi', role: 'agent' });
    expect(q.blocks[0]).toMatchObject({ kind: 'tool', text: '$ make report', result: 'before\n' + '─'.repeat(30) + '\nafter' });
    expect(q.blocks[1]).toMatchObject({ kind: 'agent', text: 'Report printed.' });
    expect(q.draft).toBe('next');
  });

  it('drops the footer in every duration format, and keeps prose that merely starts with "Took"', () => {
    for (const took of ['Took 0.6s', 'Took 42ms', 'Took 1m 23s']) {
      const q = parsePane([`${ESC}[48;5;16m`, ` ${ESC}[1m$ true${ESC}[0m${ESC}[48;5;16m`, '', ` ${ESC}[38;5;109mhi${ESC}[39m`, '', ` ${ESC}[38;5;109m${took}${ESC}[39m`].join('\n'), { provider: 'pi', role: 'agent' });
      expect(q.blocks[0].result).toBe('hi');
    }
    const prose = parsePane([`${ESC}[48;5;16m`, ` ${ESC}[1mread${ESC}[0m${ESC}[48;5;16m ${ESC}[38;5;140mnotes.md`, `${ESC}[49m`, ' Took three tries to find it.'].join('\n'), { provider: 'pi', role: 'agent' });
    expect(prose.blocks.map(b => b.text)).toContain('Took three tries to find it.');
  });

  it('takes the first bold row of a new box as its header whatever the tool is called', () => {
    const q = parsePane([`${ESC}[48;5;16m`, ` ${ESC}[1mweb_fetch${ESC}[0m${ESC}[48;5;16m ${ESC}[38;5;140mhttps://example.com/x`, '', ` ${ESC}[38;5;109m200 OK${ESC}[39m`].join('\n'), { provider: 'pi', role: 'agent' });
    expect(q.blocks[0]).toMatchObject({ kind: 'tool', text: 'web_fetch https://example.com/x', result: '200 OK' });
    expect(q.blocks[0].partial).toBeUndefined();
  });

  it('does not glue a bold first output row onto a short command title', () => {
    const q = parsePane([
      `${ESC}[48;5;16m`,
      ` ${ESC}[1m$ npm run build${ESC}[0m${ESC}[48;5;16m`,
      ` ${ESC}[1mBUILD FAILED${ESC}[0m${ESC}[48;5;16m`,
      PIDIV, '', PIDIV,
    ].join('\n'), { provider: 'pi', role: 'agent' });
    expect(q.blocks[0]).toMatchObject({ kind: 'tool', text: '$ npm run build', result: 'BUILD FAILED' });
  });

  it('starts a partial tool when the capture begins inside a box', () => {
    const q = parsePane([`${ESC}[48;5;16m ${ESC}[38;5;109mline 12 of the output${ESC}[39m`, '', ` ${ESC}[38;5;109mTook 0.1s${ESC}[39m`, '', `${ESC}[49m Done.`].join('\n'), { provider: 'pi', role: 'agent' });
    expect(q.blocks).toEqual([
      { kind: 'tool', text: '', partial: true, result: 'line 12 of the output', failed: undefined },
      { kind: 'agent', text: 'Done.', result: undefined },
    ]);
  });
});

describe('scanStyled', () => {
  it('carries the background across rows until it is reset', () => {
    const rows = scanStyled([`${ESC}[48;5;17m`, ' still on 17', `${ESC}[49m back to default`, `${ESC}[3mitalic${ESC}[23m half`]);
    expect(rows.map(r => r.bg)).toEqual([null, '17', null, null]);
    expect(rows[3].italic).toBeCloseTo(6 / 10);
    expect(rows[1].text).toBe(' still on 17');
  });
});
