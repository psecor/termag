import { describe, expect, it, vi } from 'vitest';

vi.mock('../routes/handoffs', () => ({ startHandoff: vi.fn() }));

import { isHandoffCommand, parseSlackHandoff, slackHandoff } from './handoffCommand';
import { startHandoff } from '../routes/handoffs';

describe('/t handoff', () => {
  it('is its own word, not a prefix of other text sent to the agent', () => {
    expect(isHandoffCommand('handoff')).toBe(true);
    expect(isHandoffCommand('handoff restart cursor')).toBe(true);
    expect(isHandoffCommand('handoffs are broken, please look')).toBe(false);
    expect(isHandoffCommand('please handoff')).toBe(false);
    // An instruction that starts with the word goes to the agent.
    expect(isHandoffCommand('handoff please write the docs')).toBe(false);
    expect(isHandoffCommand('handoff compact')).toBe(true);
    expect(isHandoffCommand('handoff Devin')).toBe(true);
  });

  it('defaults to clear; naming an agent restarts on it, by id or display name', () => {
    expect(parseSlackHandoff('handoff')).toEqual({ ok: true, mode: 'clear' });
    expect(parseSlackHandoff('handoff compact')).toEqual({ ok: true, mode: 'compact' });
    expect(parseSlackHandoff('handoff restart')).toEqual({ ok: true, mode: 'restart' });
    expect(parseSlackHandoff('handoff restart Cursor')).toEqual({ ok: true, mode: 'restart', provider: 'cursor' });
    expect(parseSlackHandoff('handoff devin')).toEqual({ ok: true, mode: 'restart', provider: 'devin' });
  });

  it('refuses an unknown agent and extra words', () => {
    expect(parseSlackHandoff('handoff restart gpt9')).toMatchObject({ ok: false, error: expect.stringMatching(/No agent called "gpt9"/) });
    expect(parseSlackHandoff('handoff clear now please')).toMatchObject({ ok: false });
  });

  it('says what will happen, with the fallback note, or why it will not', async () => {
    const user = { id: 'u1' } as never;
    const target = { projectId: 'p1', projectName: 'proj', workstream: 'feat' };
    vi.mocked(startHandoff).mockResolvedValueOnce({ status: 202, body: { handoff: { mode: 'restart', toProvider: 'devin' }, note: 'clear keeps the same agent; switching to Devin restarts the pane' } });
    const ok = await slackHandoff(user, target, 'handoff devin');
    expect(vi.mocked(startHandoff).mock.calls[0]).toEqual([user, { projectId: 'p1', workstream: 'feat' }, { mode: 'restart', provider: 'devin' }, { initiator: 'person', surface: 'slack' }]);
    expect(ok).toMatch(/^Handing off `proj\/feat`: .*the pane restarts on Devin/);
    expect(ok).toMatch(/_clear keeps the same agent/);
    vi.mocked(startHandoff).mockResolvedValueOnce({ status: 403, body: { error: 'agent handoff is not enabled for you on this box', code: 'handoff_disabled' } });
    expect(await slackHandoff(user, target, 'handoff')).toBe('Could not hand off `proj/feat`: agent handoff is not enabled for you on this box');
    // A channel of a project shared with the user: only the owner can hand it off.
    vi.mocked(startHandoff).mockResolvedValueOnce({ status: 404, body: { error: 'Project not found' } });
    expect(await slackHandoff(user, target, 'handoff')).toBe('Could not hand off `proj/feat`: Project not found');
  });
});
