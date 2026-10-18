import { describe, expect, it } from 'vitest';
import { rateLimitDetail, rateLimitLabel } from './rateLimit';

describe('rateLimitLabel', () => {
  it('quota and throttle messages are rate limits', () => {
    expect(rateLimitLabel("You've hit your usage limit · resets 3pm")).toBe('RATE LIMITED');
    expect(rateLimitLabel('Credit balance is too low')).toBe('RATE LIMITED');
    expect(rateLimitLabel('temporarily limiting requests')).toBe('RATE LIMITED');
    expect(rateLimitLabel('Now using extra usage')).toBe('RATE LIMITED');
  });
  it('a failed request is a provider error', () => {
    expect(rateLimitLabel('pi: model error')).toBe('PROVIDER ERROR');
    expect(rateLimitLabel('pi: model endpoint HTTP 502')).toBe('PROVIDER ERROR');
    expect(rateLimitDetail('pi: model error', 'pi')).toMatch(/last request failed/);
    expect(rateLimitDetail('usage limit reached', 'claude')).toMatch(/throttled/);
  });
});
