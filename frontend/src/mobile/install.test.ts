import { describe, expect, it } from 'vitest';
import { installOption } from './install';

describe('installOption', () => {
  it('offers nothing inside the installed app', () => {
    expect(installOption({ standalone: true, hasPrompt: true, appleMobile: true })).toBe('installed');
  });
  it('prefers the browser prompt, then iOS instructions', () => {
    expect(installOption({ standalone: false, hasPrompt: true, appleMobile: false })).toBe('prompt');
    expect(installOption({ standalone: false, hasPrompt: false, appleMobile: true })).toBe('ios-instructions');
    expect(installOption({ standalone: false, hasPrompt: false, appleMobile: false })).toBe('none');
  });
});
