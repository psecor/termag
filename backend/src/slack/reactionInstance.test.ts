import { describe, it, expect } from 'vitest';
import { trackPaneMessage, trackedPaneInstance } from './events';
import { trackDiscordPaneMessage, trackedDiscordPaneInstance } from '../discord/events';

describe('status notification reactions keep the writing instance', () => {
  it('stores a box id and does not default that message onto the orchestrator', () => {
    trackPaneMessage('C', 'box-msg', 'alice-cx-agent', 'U', 'box-a');
    trackDiscordPaneMessage('D', 'box-msg', 'alice-cx-agent', 'U', 'box-a');
    expect(trackedPaneInstance('C', 'box-msg')).toBe('box-a');
    expect(trackedDiscordPaneInstance('D', 'box-msg')).toBe('box-a');

    trackPaneMessage('C', 'host-msg', 'alice-cx-agent', 'U', null);
    expect(trackedPaneInstance('C', 'host-msg')).toBe(null);
    expect(trackedPaneInstance('C', 'host-msg')).not.toBe('box-a');
  });

  it('can keep an unassociated attach unscoped for the legacy fallback', () => {
    trackPaneMessage('C', 'legacy-attach', 'alice-old-agent', 'U', undefined);
    trackDiscordPaneMessage('D', 'legacy-attach', 'alice-old-agent', 'U', undefined);
    expect(trackedPaneInstance('C', 'legacy-attach')).toBeUndefined();
    expect(trackedDiscordPaneInstance('D', 'legacy-attach')).toBeUndefined();
  });
});