import { describe, expect, it, vi } from 'vitest';
import { CLAUDE_EXIT_KEYS, interruptAnswer, isSafeResumeLine, reclaimAnswer, reclaimChatFromPane, resumeChatInPane, sendUnlessTerminalHolds, TERMINAL_HOLDS_ANSWER, terminalAnswer, waitForClaude, type ReclaimDeps, type ResumeDeps } from './chatResume';
import { withPaneLock } from './agentRuntime';

const SESSION = '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0';
const BARE = `claude --permission-mode bypassPermissions --resume ${SESSION}`;
const CONFINED = '"$HOME/.termag/chat-resume/p1--main"';

function claimLine(line: string): ResumeDeps['claim'] {
  return async () => ({ claimed: true, running: false, line });
}

/** A clock that only moves when the code under test sleeps. */
function fakeClock() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => { t += ms; } };
}

function deps(over: Partial<ResumeDeps> & { probes?: Array<string | null> } = {}) {
  const probes = [...(over.probes ?? ['zsh', 'claude'])];
  const typed: string[] = [];
  const clock = fakeClock();
  const d: ResumeDeps = {
    history: async () => ({ sessionId: SESSION, running: false }),
    ensurePane: async () => {},
    probe: async () => (probes.length > 1 ? probes.shift()! : probes[0] ?? null),
    type: async line => { typed.push(line); },
    ...clock,
    ...over,
  };
  return { d, typed, now: clock.now };
}

describe('waitForClaude', () => {
  it('returns true once a Claude is the foreground', async () => {
    const seq = ['zsh', 'zsh', 'claude'];
    const clock = fakeClock();
    const probe = vi.fn(async () => seq.shift() ?? 'claude');
    await expect(waitForClaude(probe, { ...clock, intervalMs: 250, timeoutMs: 10_000 })).resolves.toBe(true);
    expect(probe).toHaveBeenCalledTimes(3);
  });

  it('gives up at the timeout when Claude never comes up', async () => {
    const clock = fakeClock();
    const probe = vi.fn(async () => 'zsh');
    await expect(waitForClaude(probe, { ...clock, intervalMs: 250, timeoutMs: 1_000 })).resolves.toBe(false);
    expect(clock.now()).toBe(1_000);
    expect(probe).toHaveBeenCalledTimes(5);
  });

  it('treats an unreadable probe as not yet', async () => {
    const seq: Array<string | null> = [null, 'claude'];
    const clock = fakeClock();
    await expect(waitForClaude(async () => seq.shift() ?? null, clock)).resolves.toBe(true);
  });
});

describe('resumeChatInPane', () => {
  it('refuses while a chat turn runs, without touching the pane', async () => {
    const ensurePane = vi.fn(async () => {});
    const { d, typed } = deps({ history: async () => ({ sessionId: SESSION, running: true }), ensurePane });
    await expect(resumeChatInPane(d)).resolves.toEqual({ status: 'turn-running' });
    expect(ensurePane).not.toHaveBeenCalled();
    expect(typed).toEqual([]);
  });

  it('has nothing to resume without a valid session id', async () => {
    for (const sessionId of [undefined, '', 'short', 'a; rm -rf ~']) {
      const { d, typed } = deps({ history: async () => ({ sessionId, running: false }) });
      await expect(resumeChatInPane(d)).resolves.toEqual({ status: 'skipped', reason: 'no-session' });
      expect(typed).toEqual([]);
    }
  });

  it.each([
    ['claude', 'claude-open'],
    ['git', 'pane-busy'],
    [null, 'pane-unknown'],
  ] as const)('leaves a pane whose foreground is %s alone (%s)', async (fg, reason) => {
    const { d, typed } = deps({ probes: [fg] });
    await expect(resumeChatInPane(d)).resolves.toEqual({ status: 'skipped', reason, sessionId: SESSION });
    expect(typed).toEqual([]);
  });

  it('types the runner line at a shell and waits until Claude has the pane', async () => {
    const { d, typed } = deps({ probes: ['zsh', 'zsh', 'zsh', 'claude'], claim: claimLine(CONFINED) });
    await expect(resumeChatInPane(d)).resolves.toEqual({ status: 'resumed', sessionId: SESSION, settled: true });
    expect(typed).toEqual([CONFINED]);
  });

  it('types the confined launcher and not a bare resume', async () => {
    const { d, typed } = deps({ probes: ['zsh', 'zsh', 'claude'], claim: claimLine(CONFINED) });
    await expect(resumeChatInPane(d)).resolves.toEqual({ status: 'resumed', sessionId: SESSION, settled: true });
    expect(typed).toEqual([CONFINED]);
    expect(typed[0].startsWith('exec ')).toBe(false);
    expect(typed[0]).not.toContain('--resume');
    expect(typed[0]).not.toContain(SESSION);
  });

  it('does not type a bare resume, a shell metacharacter, or a missing line', async () => {
    for (const line of [
      `claude --resume ${SESSION}`,
      `claude --resume ${SESSION}; touch /tmp/x`,
      '"$HOME/.termag/chat-resume/../p1"',
      '"$HOME/.termag/chat-resume/p1--main"; echo hi',
      'exec "$HOME/.termag/chat-resume/p1--main"',
      BARE,
      `claude --permission-mode bypassPermissions --resume ${'a'.repeat(8)}-other`,
      undefined,
    ]) {
      const release = vi.fn(async () => {});
      const { d, typed } = deps({
        probes: ['zsh'],
        claim: async () => ({ claimed: true, line }),
        release,
      });
      await expect(resumeChatInPane(d)).resolves.toEqual({ status: 'skipped', reason: 'resume-unprepared', sessionId: SESSION });
      expect(typed).toEqual([]);
      expect(release).toHaveBeenCalledWith(false, false);
    }
  });

  it('reports an unsettled resume when Claude does not come up in time', async () => {
    const release = vi.fn(async () => {});
    const { d, typed } = deps({ probes: ['zsh'], claim: claimLine(CONFINED), release });
    await expect(resumeChatInPane(d, { timeoutMs: 1_000, intervalMs: 250 }))
      .resolves.toEqual({ status: 'resumed', sessionId: SESSION, settled: false });
    expect(typed).toEqual([CONFINED]);
    expect(release).toHaveBeenCalledWith(true, false);
  });

  it('waits out an empty probe on a pane that just came up, then types into the shell', async () => {
    const { d, typed, now } = deps({ probes: [null, '', 'zsh', 'zsh', 'claude'], claim: claimLine(CONFINED) });
    await expect(resumeChatInPane(d, { shellReadyIntervalMs: 100 }))
      .resolves.toEqual({ status: 'resumed', sessionId: SESSION, settled: true });
    expect(typed).toEqual([CONFINED]);
    expect(now()).toBe(200);
  });

  it('still skips a pane that never reports a foreground', async () => {
    const { d, typed, now } = deps({ probes: [null] });
    await expect(resumeChatInPane(d, { shellReadyMs: 500, shellReadyIntervalMs: 100 }))
      .resolves.toEqual({ status: 'skipped', reason: 'pane-unknown', sessionId: SESSION });
    expect(typed).toEqual([]);
    expect(now()).toBe(500);
  });

  it('does not type into vim, and does not wait for a shell once a program is named', async () => {
    const { d, typed, now } = deps({ probes: ['vim'] });
    await expect(resumeChatInPane(d)).resolves.toEqual({ status: 'skipped', reason: 'pane-busy', sessionId: SESSION });
    expect(typed).toEqual([]);
    expect(now()).toBe(0);
  });

  it('reads history again after the pane wait, and does not type if a turn started', async () => {
    let calls = 0;
    const { d, typed } = deps({
      probes: ['zsh'],
      history: async () => ({ sessionId: SESSION, running: calls++ > 0 }),
    });
    await expect(resumeChatInPane(d)).resolves.toEqual({ status: 'turn-running' });
    expect(typed).toEqual([]);
    expect(calls).toBe(2);
  });

  it('does not type when the runner refuses the claim because a turn owns the session', async () => {
    const release = vi.fn(async () => {});
    const { d, typed } = deps({
      probes: ['zsh'],
      claim: async () => ({ claimed: false, running: true }),
      release,
    });
    await expect(resumeChatInPane(d)).resolves.toEqual({ status: 'turn-running' });
    expect(typed).toEqual([]);
    expect(release).not.toHaveBeenCalled();
  });

  it('does not type when the pane is taken while the claim inspects', async () => {
    const release = vi.fn(async () => {});
    for (const [fg, reason] of [
      ['vim', 'pane-busy'],
      ['claude', 'claude-open'],
      [null, 'pane-unknown'],
    ] as const) {
      const { d, typed } = deps({
        probes: ['zsh', fg],
        claim: claimLine(CONFINED),
        release,
      });
      await expect(resumeChatInPane(d)).resolves.toEqual({ status: 'skipped', reason, sessionId: SESSION });
      expect(typed).toEqual([]);
    }
    expect(release).toHaveBeenCalledTimes(3);
    expect(release).toHaveBeenCalledWith(false, false);
  });

  it('claims the chat before typing, and parks the queue once the resume is typed', async () => {
    const release = vi.fn(async () => {});
    const { d, typed } = deps({
      probes: ['zsh', 'zsh', 'claude'],
      claim: claimLine(CONFINED),
      release,
    });
    await expect(resumeChatInPane(d)).resolves.toEqual({ status: 'resumed', sessionId: SESSION, settled: true });
    expect(typed).toEqual([CONFINED]);
    expect(release).toHaveBeenCalledWith(true, true);
  });

  it('releases a hold when the claim reply is lost, and does not type', async () => {
    const release = vi.fn(async () => {});
    const { d, typed } = deps({
      probes: ['zsh'],
      claim: async () => { throw new Error('connection reset'); },
      release,
    });
    await expect(resumeChatInPane(d)).rejects.toThrow('connection reset');
    expect(typed).toEqual([]);
    expect(release).toHaveBeenCalledWith(false, false);
  });

  it('types nothing when the agent has no claim command, even if the pane is an idle shell', async () => {
    const { d, typed } = deps({
      probes: ['zsh'],
      claim: async () => { throw new Error('Unknown command: chat-resume-claim'); },
    });
    await expect(resumeChatInPane(d)).resolves.toEqual({ status: 'skipped', reason: 'resume-unprepared', sessionId: SESSION });
    expect(typed).toEqual([]);
  });

  it('falls back to a fresh history read when the agent has no claim command', async () => {
    let calls = 0;
    const { d, typed } = deps({
      probes: ['zsh'],
      claim: async () => { throw new Error('Unknown command: chat-resume-claim'); },
      history: async () => ({ sessionId: SESSION, running: calls++ > 0 }),
    });
    await expect(resumeChatInPane(d)).resolves.toEqual({ status: 'turn-running' });
    expect(typed).toEqual([]);
    expect(calls).toBe(2);
  });
});

describe('terminalAnswer', () => {
  it('maps a running turn to 409 and a resume or a skip to 200', () => {
    expect(terminalAnswer({ status: 'turn-running' })).toMatchObject({ status: 409, body: { code: 'turn-running' } });
    expect(terminalAnswer({ status: 'skipped', reason: 'pane-busy', sessionId: SESSION })).toEqual({
      status: 200, body: { resumed: false, reason: 'pane-busy', sessionId: SESSION },
    });
    expect(terminalAnswer({ status: 'resumed', sessionId: SESSION, settled: true })).toEqual({
      status: 200, body: { resumed: true, sessionId: SESSION, settled: true },
    });
  });
});

describe('interruptAnswer', () => {
  it('answers terminal-holds when the pane kept the queue, and 200 otherwise', () => {
    expect(interruptAnswer({ held: true, interrupted: false, dropped: [] })).toEqual(TERMINAL_HOLDS_ANSWER);
    expect(interruptAnswer({ interrupted: true, dropped: ['next'] })).toEqual({ status: 200, body: { interrupted: true, dropped: ['next'] } });
  });
});

describe('isSafeResumeLine', () => {
  it('accepts only the launcher path, and nothing a form or a bare claude could carry', () => {
    expect(isSafeResumeLine(BARE)).toBe(false);
    expect(isSafeResumeLine(CONFINED)).toBe(true);
    expect(isSafeResumeLine(`claude --resume ${SESSION}`)).toBe(false);
    expect(isSafeResumeLine(`claude --permission-mode dontAsk --resume ${SESSION}`)).toBe(false);
    expect(isSafeResumeLine('exec "$HOME/.termag/chat-resume/p1--main"')).toBe(false);
    expect(isSafeResumeLine('"$HOME/.termag/chat-resume/p1--main" && claude')).toBe(false);
    expect(isSafeResumeLine('"$HOME/.termag/chat-resume/.."')).toBe(false);
  });
});

describe('sendUnlessTerminalHolds', () => {
  it('sends when the pane is a shell, and tells the runner the probe was a shell', async () => {
    const send = vi.fn(async () => ({ queued: false }));
    await expect(sendUnlessTerminalHolds(async () => 'zsh', send)).resolves.toEqual({ held: false, result: { queued: false } });
    expect(send).toHaveBeenCalledWith('shell');
  });

  it('sends on a missed probe and names it unknown, so the runner can keep a pane claim', async () => {
    const send = vi.fn(async () => ({ queued: true }));
    await expect(sendUnlessTerminalHolds(async () => null, send)).resolves.toEqual({ held: false, result: { queued: true } });
    expect(send).toHaveBeenCalledWith('unknown');
  });

  it('refuses while a Claude holds the pane', async () => {
    const send = vi.fn(async () => ({}));
    await expect(sendUnlessTerminalHolds(async () => 'claude', send)).resolves.toEqual({ held: true });
    await expect(sendUnlessTerminalHolds(async () => ({ cmd: 'claude', dead: false }), send)).resolves.toEqual({ held: true });
    expect(send).not.toHaveBeenCalled();
  });

  it('a dead pane still named claude is stale: the send goes out as a shell, so the claim can clear', async () => {
    const send = vi.fn(async () => ({ queued: false, turnId: 't1' }));
    await expect(sendUnlessTerminalHolds(async () => ({ cmd: 'claude', dead: true }), send)).resolves.toEqual({
      held: false, result: { queued: false, turnId: 't1' },
    });
    expect(send).toHaveBeenCalledWith('shell');
  });
});

function reclaimDeps(probes: Array<Awaited<ReturnType<ReclaimDeps['probe']>>>, noted: Array<{ resume?: boolean }> = []) {
  const queue = [...probes];
  const typed: string[] = [];
  const notes: string[] = [];
  const clock = fakeClock();
  let noteAt = 0;
  const d: ReclaimDeps = {
    probe: async () => (queue.length > 1 ? queue.shift()! : queue[0] ?? null),
    exitClaude: async () => { typed.push(CLAUDE_EXIT_KEYS); },
    notePane: async probe => { notes.push(probe); return noted[noteAt++] ?? { resume: true }; },
    ...clock,
  };
  return { d, typed, notes };
}

describe('reclaimChatFromPane', () => {
  it('a shell after Claude left is stale: nothing is typed, the claim is cleared, and the chat may send', async () => {
    const { d, typed, notes } = reclaimDeps(['zsh']);
    await expect(reclaimChatFromPane(d)).resolves.toEqual({ status: 'free', typed: false });
    expect(typed).toEqual([]);
    expect(notes).toEqual(['shell']);
    expect(CLAUDE_EXIT_KEYS).toBe('/exit');
  });

  it('a dead pane still named claude is the same stale hold', async () => {
    const { d, typed, notes } = reclaimDeps([{ cmd: 'claude', dead: true }]);
    await expect(reclaimChatFromPane(d)).resolves.toEqual({ status: 'free', typed: false });
    expect(typed).toEqual([]);
    expect(notes).toEqual(['shell']);
  });

  it('does not clear a claim, or type, while a resume is still coming up in the shell', async () => {
    const { d, typed, notes } = reclaimDeps(['zsh'], [{ resume: false }]);
    await expect(reclaimChatFromPane(d)).resolves.toEqual({ status: 'held', typed: false, reason: 'starting' });
    expect(typed).toEqual([]);
    expect(notes).toEqual(['shell']);
  });

  it('a live Claude is exited once, then the claim clears, and nothing else is typed', async () => {
    const { d, typed, notes } = reclaimDeps(['claude', 'claude', 'zsh', 'zsh']);
    await expect(reclaimChatFromPane(d)).resolves.toEqual({ status: 'reclaimed', typed: true });
    expect(typed).toEqual(['/exit']);
    expect(notes).toEqual(['claude', 'shell']);
  });

  it('Claude that exits between the two probes is stale: /exit is not typed into the shell', async () => {
    const { d, typed, notes } = reclaimDeps(['claude', 'zsh']);
    await expect(reclaimChatFromPane(d)).resolves.toEqual({ status: 'free', typed: false });
    expect(typed).toEqual([]);
    expect(notes).toEqual(['shell']);
  });

  it('Claude that stays is still attached: one /exit, no send, the claim stays', async () => {
    const { d, typed, notes } = reclaimDeps(['claude'], []);
    await expect(reclaimChatFromPane(d, { timeoutMs: 1_000, intervalMs: 250 })).resolves.toEqual({
      status: 'held', typed: true, reason: 'claude-open',
    });
    expect(typed).toEqual(['/exit']);
    expect(notes).toEqual(['claude']);
  });

  it('does not type /exit into vim or an unreadable pane', async () => {
    const vim = reclaimDeps(['vim']);
    await expect(reclaimChatFromPane(vim.d)).resolves.toEqual({ status: 'held', typed: false, reason: 'pane-busy' });
    expect(vim.typed).toEqual([]);
    expect(vim.notes).toEqual([]);
    const missed = reclaimDeps([null]);
    await expect(reclaimChatFromPane(missed.d)).resolves.toEqual({ status: 'held', typed: false, reason: 'pane-unknown' });
    expect(missed.typed).toEqual([]);
    expect(missed.notes).toEqual([]);
  });
});

describe('reclaimAnswer', () => {
  it('a hold is the terminal-holds refusal and carries no send', () => {
    expect(reclaimAnswer({ status: 'held', typed: true, reason: 'claude-open' })).toEqual({
      status: 409,
      body: { ...TERMINAL_HOLDS_ANSWER.body, reclaimed: false, typed: true, reason: 'claude-open' },
    });
    expect(reclaimAnswer({ status: 'free', typed: false })).toEqual({
      status: 200, body: { reclaimed: true, typed: false, sent: false },
    });
    expect(reclaimAnswer({ status: 'reclaimed', typed: true }, { queued: false, turnId: 't1' })).toEqual({
      status: 202, body: { reclaimed: true, typed: true, sent: true, queued: false, turnId: 't1' },
    });
  });
});

describe('resume and send under one pane lock', () => {
  /** A pane whose foreground turns into Claude a few probes after the resume is typed. */
  function pane() {
    let fg = 'zsh';
    let typedAt = -1;
    let probes = 0;
    return {
      probe: async () => {
        probes += 1;
        if (typedAt >= 0 && probes - typedAt >= 3) fg = 'claude';
        await new Promise(r => setTimeout(r, 1));
        return fg;
      },
      type: async () => { typedAt = probes; },
    };
  }

  it('a send that arrives mid-resume waits and is refused, never typed into the shell', async () => {
    const p = pane();
    const key = `test:${Math.random()}`;
    const sent = vi.fn(async () => ({}));
    const resume = withPaneLock(key, () => resumeChatInPane({
      history: async () => ({ sessionId: SESSION, running: false }),
      claim: claimLine(CONFINED),
      ensurePane: async () => {},
      probe: p.probe,
      type: p.type,
    }, { intervalMs: 1, timeoutMs: 1_000 }));
    // Queued while the resume is still waiting for Claude to come up.
    const send = withPaneLock(key, () => sendUnlessTerminalHolds(p.probe, sent));
    await expect(resume).resolves.toMatchObject({ status: 'resumed', settled: true });
    await expect(send).resolves.toEqual({ held: true });
    expect(sent).not.toHaveBeenCalled();
  });

  it('a second resume queued behind the first sees Claude and types nothing', async () => {
    const p = pane();
    const key = `test:${Math.random()}`;
    const typed: string[] = [];
    const run = () => withPaneLock(key, () => resumeChatInPane({
      history: async () => ({ sessionId: SESSION, running: false }),
      claim: claimLine(CONFINED),
      ensurePane: async () => {},
      probe: p.probe,
      type: async line => { typed.push(line); await p.type(); },
    }, { intervalMs: 1, timeoutMs: 1_000 }));
    const [first, second] = await Promise.all([run(), run()]);
    expect(first).toMatchObject({ status: 'resumed', settled: true });
    expect(second).toEqual({ status: 'skipped', reason: 'claude-open', sessionId: SESSION });
    expect(typed).toHaveLength(1);
  });
});
