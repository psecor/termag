import { describe, expect, it } from 'vitest';
import { settingsBackLink } from './backLink';

describe('settingsBackLink', () => {
  it('goes back to the sessions when Settings was opened from /chat', () => {
    expect(settingsBackLink('?from=chat')).toEqual({ to: '/chat', label: '← sessions' });
    expect(settingsBackLink('')).toEqual({ to: '/', label: '← workspace' });
    expect(settingsBackLink('?from=dashboard')).toEqual({ to: '/', label: '← workspace' });
  });
});
