import { afterEach, describe, expect, it, vi } from 'vitest';

// The axios instance api.ts creates, so the test sees the request it makes.
const get = vi.hoisted(() => vi.fn(async () => ({ data: { id: 'u1' } })));
vi.mock('axios', () => ({
  default: { create: () => ({ get, post: vi.fn(), put: vi.fn(), delete: vi.fn(), interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } }, defaults: { headers: { common: {} } } }) },
}));

import { authApi } from './api';

afterEach(() => { get.mockClear(); vi.restoreAllMocks(); });

describe('authApi.me', () => {
  it("sends the browser's IANA zone at sign-in, which the server keeps as User.timeZone", async () => {
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({ timeZone: 'Europe/Berlin' } as Intl.ResolvedDateTimeFormatOptions);
    await authApi.me();
    expect(get).toHaveBeenCalledWith('/auth/me', { params: { tz: 'Europe/Berlin' } });
  });

  it('sends no zone when the browser cannot say', async () => {
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockImplementation(() => { throw new Error('no Intl'); });
    await authApi.me();
    expect(get).toHaveBeenCalledWith('/auth/me', { params: { tz: undefined } });
  });
});
