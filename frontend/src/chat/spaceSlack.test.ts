import { describe, expect, it, vi } from 'vitest';
import { channelNameProblem, defaultChannelName, linkedLine, pickerHint, previewLines, slackErrorText, spaceSlackActions } from './spaceSlack';

describe('spaceSlackActions: the space menu\'s Slack channels', () => {
  it('is offered only with space-channels-enabled on, and never for "No space"', () => {
    const open = vi.fn();
    expect(spaceSlackActions('payments', false, open)).toEqual([]);
    expect(spaceSlackActions(null, true, open)).toEqual([]);
    const [item] = spaceSlackActions('payments', true, open);
    expect(item.label).toBe('Slack channels');
    item.onSelect();
    expect(open).toHaveBeenCalledWith('payments');
  });
});

describe('a new channel\'s name', () => {
  it('follows Slack\'s rules and keeps proj-… for workstreams', () => {
    expect(channelNameProblem('space-payments')).toBeNull();
    expect(channelNameProblem('a_b-9')).toBeNull();
    expect(channelNameProblem('')).toMatch(/Name/);
    expect(channelNameProblem('Payments')).toMatch(/lowercase/);
    expect(channelNameProblem('has space')).toMatch(/lowercase/);
    expect(channelNameProblem('x'.repeat(81))).toMatch(/80/);
    expect(channelNameProblem('proj-me-x')).toMatch(/workstream/);
    expect(defaultChannelName('payments')).toBe('space-payments');
  });
});

describe('wording', () => {
  it('says why a picker entry can\'t be picked, naming the space only when known', () => {
    const c = { id: 'C1', name: 'general', private: false, termagIn: false, members: 14 };
    expect(pickerHint(c, 'payments')).toBe('14 members · termag joins when you link it');
    expect(pickerHint({ ...c, private: true, termagIn: true, members: 1 }, 'payments')).toBe('Private · 1 member');
    expect(pickerHint({ ...c, disabled: 'channel_linked', linkedTo: 'payments' }, 'payments')).toBe('Already linked to payments');
    expect(pickerHint({ ...c, disabled: 'channel_linked', linkedTo: null }, 'payments')).toBe('Already linked to another space');
    expect(pickerHint({ ...c, disabled: 'channel_workstream' }, 'payments')).toMatch(/workstream/);
    expect(pickerHint({ ...c, disabled: 'not_in_channel' }, 'payments')).toBe('You aren\'t in this channel: join it in Slack to link it');
    expect(pickerHint({ ...c, disabled: 'actor_not_in_slack' }, 'payments')).toMatch(/Slack account/);
    expect(pickerHint({ ...c, private: true }, 'payments', { allowPrivate: false })).toMatch(/Private channels can't be linked/);
    expect(pickerHint({ ...c, private: true }, 'payments', { allowPrivate: true })).toMatch(/^Private/);
  });

  it('puts the bystanders and the invite first, and the first link after', () => {
    const lines = previewLines({ bystanders: 3, needsInvite: false, firstLink: true, channelName: 'general', isPrivate: false }, 'payments');
    expect(lines.map(l => l.tone)).toEqual(['warning', 'info']);
    expect(lines[0].text).toMatch(/^3 people in this channel aren't members of payments/);
    expect(lines[1].text).toMatch(/first channel/);
    expect(previewLines({ bystanders: 1, needsInvite: false, firstLink: false, channelName: null, isPrivate: false }, 'p')[0].text).toMatch(/^1 person .* isn't a member/);
    expect(previewLines({ bystanders: 0, needsInvite: false, firstLink: false, channelName: null, isPrivate: false }, 'p')[0].tone).toBe('info');
    expect(previewLines({ bystanders: null, needsInvite: true, firstLink: false, channelName: null, isPrivate: true }, 'p').map(l => l.text)).toEqual([
      expect.stringMatching(/\/invite @termag/),
    ]);
  });

  it('says only that a channel is already linked, when it is', () => {
    expect(previewLines({ bystanders: null, needsInvite: false, firstLink: false, channelName: 'general', isPrivate: false, alreadyLinked: true }, 'payments'))
      .toEqual([{ tone: 'info', text: '#general is already linked to payments.' }]);
  });

  it('says who linked a channel, and how', () => {
    const c = {
      channelId: 'C1', name: 'general', private: false, createdByTermag: false, linkedBy: { userId: 'u', email: 'ana@example.com' },
      linkedVia: 'cli', linkedAt: '2026-11-04T10:00:00.000Z', paused: true,
    };
    expect(linkedLine(c, new Date('2026-11-05T00:00:00Z'))).toMatch(/^Linked by ana@example.com via the CLI · .+ · paused$/);
    expect(linkedLine({ ...c, linkedVia: 'slack_command', paused: false })).toMatch(/via \/termag link/);
  });

  it('uses the server\'s refusal, with its suggestion', () => {
    expect(slackErrorText({ response: { data: { error: 'That name is taken.', suggestion: 'general-2' } } }, 'x')).toBe('That name is taken. Try general-2.');
    expect(slackErrorText(new Error('network'), 'Could not')).toBe('Could not');
  });
});
