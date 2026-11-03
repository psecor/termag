import { describe, it, expect, vi } from 'vitest';

vi.mock('../db', () => ({ prisma: {} }));

const { CHANGED_DELAY_MS, OPENED_READS_MS, chatPrChangeListener, isPrChangeCommand, prLiveUpdates } = await import('./prLiveUpdates');
type Deps = Parameters<typeof prLiveUpdates>[0];
type Seen = Parameters<ReturnType<typeof chatPrChangeListener>>[0];

const PR = { repo: 'example-org/termag', number: 931 };
const OTHER = { repo: 'example-org/termag', number: 700 };

/** Deps whose list has `listedAt[i]` on the i-th read, recording the waits and the notifies. */
function deps(listedAt: Array<Array<{ repo: string; number: number }> | null>, enabled = true) {
  const waits: number[] = [];
  const notified: string[] = [];
  let reads = 0;
  const d: Deps = {
    enabled: async () => enabled,
    reread: async () => listedAt[Math.min(reads++, listedAt.length - 1)],
    notify: userId => { notified.push(userId); },
    wait: async ms => { waits.push(ms); },
  };
  return { d, waits, notified, reads: () => reads };
}

describe('isPrChangeCommand', () => {
  it('matches a push and the gh pr commands that change a PR, at a command boundary', () => {
    expect(isPrChangeCommand('git push -u origin HEAD')).toBe(true);
    expect(isPrChangeCommand('cd .worktrees/x && git push')).toBe(true);
    expect(isPrChangeCommand('git -C .worktrees/x push --force-with-lease')).toBe(true);
    expect(isPrChangeCommand('gh pr merge 931 --squash')).toBe(true);
    expect(isPrChangeCommand('gh pr ready 931')).toBe(true);
    expect(isPrChangeCommand('gh pr edit 931 --title x')).toBe(true);
    expect(isPrChangeCommand('gh pr review 931 --approve')).toBe(true);
    expect(isPrChangeCommand('gh pr close 931; gh pr reopen 931')).toBe(true);
  });
  it('does not match a mention, a read, a create (onPrCreated has those) or a longer name', () => {
    expect(isPrChangeCommand('echo git push')).toBe(false);
    expect(isPrChangeCommand('git status && git log')).toBe(false);
    expect(isPrChangeCommand('gh pr view 931')).toBe(false);
    expect(isPrChangeCommand('gh pr checks 931 --watch')).toBe(false);
    expect(isPrChangeCommand('gh pr create --fill')).toBe(false);
    expect(isPrChangeCommand('git pushx')).toBe(false);
  });
  it('ignores a heredoc body', () => {
    expect(isPrChangeCommand("cat > notes.md <<'EOF'\ngit push\nEOF")).toBe(false);
  });
});

describe('prLiveUpdates.opened', () => {
  it('reads the list until it has the new PR, then tells the browsers once', async () => {
    const { d, waits, notified, reads } = deps([[OTHER], [OTHER], [OTHER, PR]]);
    await prLiveUpdates(d).opened('u1', PR);
    expect(reads()).toBe(3);
    expect(waits).toEqual(OPENED_READS_MS.slice(1, 3));
    expect(notified).toEqual(['u1']);
  });

  it('stops after its last read and tells the browsers anyway', async () => {
    const { d, notified, reads } = deps([[OTHER]]);
    await prLiveUpdates(d).opened('u1', PR);
    expect(reads()).toBe(OPENED_READS_MS.length);
    expect(notified).toEqual(['u1']);
  });

  it('matches the repository whatever its case', async () => {
    const { d, reads } = deps([[{ repo: 'Example-Org/Termag', number: 931 }]]);
    await prLiveUpdates(d).opened('u1', PR);
    expect(reads()).toBe(1);
  });

  it('keeps reading past a list that could not be read', async () => {
    const { d, notified, reads } = deps([null, [PR]]);
    await prLiveUpdates(d).opened('u1', PR);
    expect(reads()).toBe(2);
    expect(notified).toEqual(['u1']);
  });

  it('does nothing with the flag off', async () => {
    const { d, notified, reads } = deps([[PR]], false);
    await prLiveUpdates(d).opened('u1', PR);
    expect(reads()).toBe(0);
    expect(notified).toEqual([]);
  });

  it('a PR opened while a loop runs joins it: one loop, one tell, both found', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const lists = [[OTHER], [PR], [PR, OTHER]];
    let reads = 0;
    const notified: string[] = [];
    const live = prLiveUpdates({
      enabled: async () => true,
      reread: async () => lists[Math.min(reads++, lists.length - 1)],
      notify: userId => { notified.push(userId); },
      wait: async () => { await gate; },
    });
    const first = live.opened('u1', PR);
    await new Promise(r => setTimeout(r, 0));
    const second = live.opened('u1', OTHER);
    await second;
    release();
    await first;
    expect(reads).toBe(3);
    expect(notified).toEqual(['u1']);
  });
});

describe('prLiveUpdates.changed', () => {
  it('tells the browsers after a short wait', async () => {
    const { d, waits, notified, reads } = deps([[PR]]);
    await prLiveUpdates(d).changed('u1');
    expect(waits).toEqual([CHANGED_DELAY_MS]);
    expect(notified).toEqual(['u1']);
    expect(reads()).toBe(0);
  });

  it('does nothing with the flag off', async () => {
    const { d, notified } = deps([[PR]], false);
    await prLiveUpdates(d).changed('u1');
    expect(notified).toEqual([]);
  });
});

describe('chatPrChangeListener', () => {
  const seen = (event: unknown): Seen => ({ projectId: 'p1', workstream: 'main', workstreamId: 'w1', instanceId: 'i1', turnId: 't1', event });
  const bash = (id: string, command: string) => seen({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } });
  const result = (id: string, isError = false) => seen({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok', is_error: isError }] } });
  const flush = () => new Promise(r => setTimeout(r, 0));

  it("tells the project's owner when a chat's push succeeds", async () => {
    const changed = vi.fn(async () => {});
    const ownerOf = vi.fn(async () => 'u1');
    const listen = chatPrChangeListener({ changed }, ownerOf);
    listen(bash('toolu_1', 'git push -u origin HEAD'));
    expect(ownerOf).not.toHaveBeenCalled();
    listen(result('toolu_1'));
    await flush();
    expect(ownerOf).toHaveBeenCalledWith('p1', 'i1');
    expect(changed).toHaveBeenCalledWith('u1');
  });

  it('says nothing for a push that failed, a command that changes no PR, or a project no longer on the box', async () => {
    const changed = vi.fn(async () => {});
    const listen = chatPrChangeListener({ changed }, async () => 'u1');
    listen(bash('toolu_1', 'git push'));
    listen(result('toolu_1', true));
    listen(bash('toolu_2', 'git status'));
    listen(result('toolu_2'));
    await flush();
    expect(changed).not.toHaveBeenCalled();
    const gone = chatPrChangeListener({ changed }, async () => null);
    gone(bash('toolu_3', 'gh pr merge 931 --squash'));
    gone(result('toolu_3'));
    await flush();
    expect(changed).not.toHaveBeenCalled();
  });
});
