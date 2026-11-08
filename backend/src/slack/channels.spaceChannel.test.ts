import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./app', () => ({ getSlackApp: () => null }));

import { createSpaceChannel, defaultSpaceChannelName, spaceChannelNameProblem, SPACE_CHANNEL_INVITE_BATCH } from './channels';

const slackError = (error: string) => Object.assign(new Error(`An API error occurred: ${error}`), { data: { ok: false, error } });

function fakeClient() {
  return {
    conversations: {
      create: vi.fn(async (_: { name: string; is_private: boolean }) => ({ channel: { id: 'CNEW0001' } })),
      invite: vi.fn(async (_: { channel: string; users: string }) => ({ ok: true })),
      archive: vi.fn(async (_: { channel: string }) => ({ ok: true })),
      list: vi.fn(async (_: unknown) => ({ channels: [] as Array<{ name: string }>, response_metadata: { next_cursor: '' } })),
      // Never called: a taken name is refused, not joined.
      join: vi.fn(async () => ({ ok: true })),
    },
  };
}

let client: ReturnType<typeof fakeClient>;
beforeEach(() => { client = fakeClient(); });

describe('space channel names', () => {
  it('allows lowercase letters, digits, - and _ up to 80 characters', () => {
    expect(spaceChannelNameProblem('payments_team-2')).toBeNull();
    expect(spaceChannelNameProblem('a'.repeat(80))).toBeNull();
  });

  it('names the rule a bad name breaks', () => {
    expect(spaceChannelNameProblem('')).toBe('empty');
    expect(spaceChannelNameProblem('a'.repeat(81))).toBe('too_long');
    expect(spaceChannelNameProblem('Payments')).toBe('characters');
    expect(spaceChannelNameProblem('pay ments')).toBe('characters');
    expect(spaceChannelNameProblem('proj-alice-termag')).toBe('proj_prefix');
  });

  it('suggests space-<name> by default', () => {
    expect(defaultSpaceChannelName('payments')).toBe('space-payments');
  });
});

describe('createSpaceChannel', () => {
  it('refuses a bad name before calling Slack', async () => {
    const res = await createSpaceChannel({ name: 'proj-mine', private: false, ownerSlackId: 'UOWNER01' }, client);
    expect(res).toMatchObject({ ok: false, code: 'name_invalid', rule: 'proj_prefix' });
    expect(client.conversations.create).not.toHaveBeenCalled();
  });

  it('is public by default and private on request', async () => {
    await createSpaceChannel({ name: 'space-payments', private: false, ownerSlackId: 'UOWNER01' }, client);
    await createSpaceChannel({ name: 'space-secret', private: true, ownerSlackId: 'UOWNER01' }, client);
    expect(client.conversations.create.mock.calls.map(c => c[0])).toEqual([
      { name: 'space-payments', is_private: false },
      { name: 'space-secret', is_private: true },
    ]);
  });

  it('invites the owner first, then the members in batches, without the owner twice', async () => {
    const members = Array.from({ length: SPACE_CHANNEL_INVITE_BATCH + 5 }, (_, i) => `UM${String(i).padStart(6, '0')}`);
    const res = await createSpaceChannel({ name: 'space-payments', private: false, ownerSlackId: 'UOWNER01', inviteSlackIds: ['UOWNER01', ...members] }, client);
    expect(res).toMatchObject({ ok: true, channelId: 'CNEW0001', failedInvites: [] });
    if (!res.ok) throw new Error('unreachable');
    expect(res.invited).toHaveLength(members.length + 1);
    const calls = client.conversations.invite.mock.calls.map(c => c[0].users.split(','));
    expect(calls[0]).toEqual(['UOWNER01']);
    expect(calls[1]).toHaveLength(SPACE_CHANNEL_INVITE_BATCH);
    expect(calls[2]).toHaveLength(5);
  });

  it('refuses a taken name with a free suggestion and never joins the existing channel', async () => {
    client.conversations.create.mockRejectedValueOnce(slackError('name_taken'));
    client.conversations.list
      .mockResolvedValueOnce({ channels: [{ name: 'space-payments' }, { name: 'space-payments-2' }], response_metadata: { next_cursor: 'next' } })
      .mockResolvedValueOnce({ channels: [{ name: 'space-payments-3' }], response_metadata: { next_cursor: '' } });
    const res = await createSpaceChannel({ name: 'space-payments', private: false, ownerSlackId: 'UOWNER01' }, client);
    expect(res).toEqual({ ok: false, code: 'name_taken', suggestion: 'space-payments-4' });
    expect(client.conversations.join).not.toHaveBeenCalled();
    expect(client.conversations.invite).not.toHaveBeenCalled();
  });

  it('keeps a suggestion within 80 characters', async () => {
    client.conversations.create.mockRejectedValueOnce(slackError('name_taken'));
    const res = await createSpaceChannel({ name: 'a'.repeat(80), private: false, ownerSlackId: 'UOWNER01' }, client);
    expect(res).toMatchObject({ ok: false, code: 'name_taken' });
    if (res.ok) throw new Error('unreachable');
    expect(res.suggestion).toBe(`${'a'.repeat(78)}-2`);
  });

  it('archives the new channel when the owner invite fails', async () => {
    client.conversations.invite.mockRejectedValueOnce(slackError('user_is_restricted'));
    const res = await createSpaceChannel({ name: 'space-payments', private: true, ownerSlackId: 'UOWNER01', inviteSlackIds: ['UM1'] }, client);
    expect(res).toEqual({ ok: false, code: 'slack_error', error: 'owner_invite_failed: user_is_restricted' });
    expect(client.conversations.archive).toHaveBeenCalledWith({ channel: 'CNEW0001' });
    expect(client.conversations.invite).toHaveBeenCalledTimes(1);
  });

  it('reports failed member invites, one by one, instead of swallowing them', async () => {
    client.conversations.invite.mockImplementation(async ({ users }: { channel: string; users: string }) => {
      if (users.split(',').includes('UBAD0001')) throw slackError(users === 'UBAD0001' ? 'user_not_found' : 'failed_for_some_users');
      if (users === 'UIN00001') throw slackError('already_in_channel');
      return { ok: true };
    });
    const res = await createSpaceChannel({ name: 'space-payments', private: false, ownerSlackId: 'UOWNER01', inviteSlackIds: ['UGOOD001', 'UBAD0001', 'UIN00001'] }, client);
    expect(res).toEqual({
      ok: true, channelId: 'CNEW0001',
      invited: ['UOWNER01', 'UGOOD001', 'UIN00001'],
      failedInvites: [{ id: 'UBAD0001', error: 'user_not_found' }],
    });
    expect(client.conversations.archive).not.toHaveBeenCalled();
  });

  it('returns restricted_action as such, and any other failure with its reason', async () => {
    client.conversations.create.mockRejectedValueOnce(slackError('restricted_action'));
    expect(await createSpaceChannel({ name: 'space-a', private: false, ownerSlackId: 'U1' }, client)).toEqual({ ok: false, code: 'restricted_action', error: 'restricted_action' });
    client.conversations.create.mockRejectedValueOnce(slackError('ratelimited'));
    expect(await createSpaceChannel({ name: 'space-a', private: false, ownerSlackId: 'U1' }, client)).toEqual({ ok: false, code: 'slack_error', error: 'ratelimited' });
  });

  it('says Slack is not configured when there is no client', async () => {
    expect(await createSpaceChannel({ name: 'space-a', private: false, ownerSlackId: 'U1' })).toEqual({ ok: false, code: 'slack_error', error: 'slack_not_configured' });
  });
});
