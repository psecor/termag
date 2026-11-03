import { describe, it, expect, vi } from 'vitest';

vi.mock('../db', () => ({ prisma: {} }));

const { chatPrLinkListener, isPrCreateCommand, prCreateTracker, stripHeredocs } = await import('./chatPrLinks');
type Seen = Parameters<ReturnType<typeof prCreateTracker>>[0];

const URL = 'https://github.com/example-org/termag/pull/844';
const seen = (event: unknown, over: Partial<Seen> = {}): Seen => ({
  projectId: 'p1', workstream: 'main', workstreamId: 'w1', instanceId: 'i1', turnId: 't1', event, ...over,
});
const bash = (id: string, command: string) => seen({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } });
const result = (id: string, content: unknown, extra: Record<string, unknown> = {}, block: Record<string, unknown> = {}) =>
  seen({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content, ...block }] }, ...extra });

describe('isPrCreateCommand', () => {
  it('matches gh pr create and termag-pr-create at a command boundary', () => {
    expect(isPrCreateCommand('gh pr create --draft --title x --body y')).toBe(true);
    expect(isPrCreateCommand('cd .worktrees/test-pr-view && gh pr create --fill')).toBe(true);
    expect(isPrCreateCommand('git push -u origin HEAD; gh  pr\tcreate')).toBe(true);
    expect(isPrCreateCommand('(gh pr create --fill)')).toBe(true);
    expect(isPrCreateCommand('termag-pr-create --title x')).toBe(true);
    expect(isPrCreateCommand('~/.claude/skills/termag-pr/termag-pr-create')).toBe(true);
    expect(isPrCreateCommand('git status\ngh pr create --fill')).toBe(true);
  });
  it('does not match a mention, another gh command, or a longer name', () => {
    expect(isPrCreateCommand('echo gh pr create')).toBe(false);
    expect(isPrCreateCommand('gh pr view 844')).toBe(false);
    expect(isPrCreateCommand('gh pr merge 844 --squash')).toBe(false);
    expect(isPrCreateCommand('gh pr created')).toBe(false);
    expect(isPrCreateCommand('termag-pr-create-helper')).toBe(false);
  });
  it('ignores a heredoc body, but not the line that opens it', () => {
    expect(isPrCreateCommand("cat > notes.md <<'EOF'\ngh pr create\nEOF")).toBe(false);
    expect(isPrCreateCommand("gh pr create --body-file - <<'EOF'\nThe body\nEOF")).toBe(true);
    expect(isPrCreateCommand('cat <<-END\n\tgh pr create\n\tEND\ngh pr create --fill')).toBe(true);
  });
});

describe('stripHeredocs', () => {
  it('drops each body up to its terminator, leading whitespace allowed', () => {
    expect(stripHeredocs('a <<"X"\nbody\n  X\nb')).toBe('a <<"X"\nb');
    expect(stripHeredocs('no heredoc here')).toBe('no heredoc here');
  });
});

describe('prCreateTracker', () => {
  it('reports a create that succeeded, from the URL on stdout', () => {
    const track = prCreateTracker();
    expect(track(bash('toolu_1', 'gh pr create --draft'))).toEqual([]);
    expect(track(result('toolu_1', `Creating draft pull request\n${URL}`, { tool_use_result: { stdout: `${URL}\n`, stderr: 'Creating draft pull request' } }))).toEqual([URL]);
  });
  it('reads the event Claude Code 2.1 sends for a Bash call', () => {
    const track = prCreateTracker();
    track(bash('toolu_01R9', 'gh pr create --draft --fill'));
    const event = {
      type: 'user',
      message: { role: 'user', content: [{ tool_use_id: 'toolu_01R9', type: 'tool_result', content: `${URL}\nwarning: 1 uncommitted change`, is_error: false }] },
      parent_tool_use_id: null,
      tool_use_result: { stdout: `${URL}\nwarning: 1 uncommitted change`, stderr: '', interrupted: false, isImage: false, noOutputExpected: false },
    };
    expect(track(seen(event))).toEqual([URL]);
  });
  it('reads the result text when there is no separate stdout, as text blocks too', () => {
    const track = prCreateTracker();
    track(bash('toolu_1', 'gh pr create'));
    expect(track(result('toolu_1', [{ type: 'text', text: URL }]))).toEqual([URL]);
  });
  it('reads only stdout when it is apart: an existing PR named on stderr was not opened', () => {
    const track = prCreateTracker();
    track(bash('toolu_1', 'gh pr create --fill || true'));
    const content = `a pull request for branch "x" into branch "main" already exists:\n${URL}`;
    expect(track(result('toolu_1', content, { tool_use_result: { stdout: '', stderr: content } }))).toEqual([]);
  });
  it('reports nothing for a failed create, another command, or a result it never saw the call for', () => {
    const track = prCreateTracker();
    track(bash('toolu_1', 'gh pr create'));
    expect(track(result('toolu_1', `Error: Exit code 1\n${URL}`, {}, { is_error: true }))).toEqual([]);
    track(bash('toolu_2', `gh pr view ${URL}`));
    expect(track(result('toolu_2', URL))).toEqual([]);
    expect(track(result('toolu_3', URL))).toEqual([]);
    track(bash('toolu_4', 'gh pr create'));
    expect(track(result('toolu_4', 'no URL printed'))).toEqual([]);
  });
  it('answers each call once, and only in its own project', () => {
    const track = prCreateTracker();
    track(bash('toolu_1', 'gh pr create'));
    expect(track(result('toolu_1', URL, {}, {}))).toEqual([URL]);
    expect(track(result('toolu_1', URL))).toEqual([]);
    track(bash('toolu_2', 'gh pr create'));
    expect(track({ ...result('toolu_2', URL), projectId: 'p2' })).toEqual([]);
    expect(track(result('toolu_2', URL))).toEqual([URL]);
  });
  it('ignores a tool that is not Bash, and junk events', () => {
    const track = prCreateTracker();
    track(seen({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Write', input: { command: 'gh pr create' } }] } }));
    expect(track(result('toolu_1', URL))).toEqual([]);
    expect(track(seen(null))).toEqual([]);
    expect(track(seen({ type: 'assistant', message: { content: 'text' } }))).toEqual([]);
    expect(track(seen({ type: 'user', message: { content: [null, 7] } }))).toEqual([]);
  });
});

describe('chatPrLinkListener', () => {
  const flush = () => new Promise(r => setTimeout(r, 0));

  it('records a PR the chat opened against its workstream, as its project\'s owner', async () => {
    const ownerOf = vi.fn(async () => 'u1');
    const record = vi.fn(async () => true);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const listen = chatPrLinkListener({ ownerOf, record });
      listen(bash('toolu_1', 'gh pr create --draft'));
      listen(result('toolu_1', URL));
      await flush();
      expect(ownerOf).toHaveBeenCalledWith('p1', 'i1');
      expect(record).toHaveBeenCalledWith({ userId: 'u1', projectId: 'p1', workstream: 'main', pr: { repo: 'example-org/termag', number: 844 } });
    } finally { log.mockRestore(); }
  });
  it('records nothing when the project is not on the box any more, and logs a failed write', async () => {
    const record = vi.fn(async () => true);
    const listen = chatPrLinkListener({ ownerOf: vi.fn(async () => null), record });
    listen(bash('toolu_1', 'gh pr create'));
    listen(result('toolu_1', URL));
    await flush();
    expect(record).not.toHaveBeenCalled();

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const failing = chatPrLinkListener({ ownerOf: vi.fn(async () => 'u1'), record: vi.fn(async () => { throw new Error('db down'); }) });
      failing(bash('toolu_2', 'gh pr create'));
      failing(result('toolu_2', URL));
      await flush();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('example-org/termag#844'), 'db down');
    } finally { warn.mockRestore(); }
  });
});
