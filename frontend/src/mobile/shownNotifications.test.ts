import { describe, expect, it } from 'vitest';
import { infersTaps, notificationKey, RECORD_MAX_AGE_MS, vanished, type ShownRecord } from './shownNotifications';

const rec = (tag: string, at = 1000): ShownRecord => ({ tag, url: `https://h/termag/m/p/${tag}`, at });

describe('notificationKey', () => {
  it('drops the per-push id and keeps old tags whole', () => {
    expect(notificationKey('box-a|alice-cx-agent#lq3x1')).toBe('box-a|alice-cx-agent');
    expect(notificationKey('box-a|alice-cx-agent')).toBe('box-a|alice-cx-agent');
    expect(notificationKey('termag-test#lq3x1')).toBe('termag-test');
    expect(notificationKey(undefined)).toBe('');
  });
});

describe('vanished', () => {
  it('opens the one notification that went, and forgets it', () => {
    const r = vanished([rec('a#1'), rec('b#1')], new Set(['b#1']), 2000);
    expect(r).toEqual({ hit: rec('a#1'), forget: ['a#1'] });
  });

  it('opens nothing when none went', () => {
    expect(vanished([rec('a#1')], new Set(['a#1', 'other']), 2000)).toEqual({ hit: null, forget: [] });
  });

  it('opens nothing when two or more went at once (Clear All), but forgets them', () => {
    expect(vanished([rec('a#1'), rec('b#1')], new Set(), 2000)).toEqual({ hit: null, forget: ['a#1', 'b#1'] });
  });

  it('drops old records still on screen without opening them', () => {
    const now = 1000 + RECORD_MAX_AGE_MS + 1;
    expect(vanished([rec('a#1')], new Set(['a#1']), now)).toEqual({ hit: null, forget: ['a#1'] });
  });
});

describe('infersTaps', () => {
  it('only in an installed app on Apple WebKit', () => {
    expect(infersTaps({ vendor: 'Apple Computer, Inc.', standalone: true })).toBe(true);
    expect(infersTaps({ vendor: 'Apple Computer, Inc.', standalone: false })).toBe(false);
    expect(infersTaps({ vendor: 'Google Inc.', standalone: true })).toBe(false);
    expect(infersTaps({ vendor: '', standalone: true })).toBe(false);
  });
});
