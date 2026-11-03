import { describe, it, expect, vi } from 'vitest';
import axios, { type InternalAxiosRequestConfig } from 'axios';
import { BUILD_SHA, clientHeader, sendClientHeader } from './buildInfo';

describe('clientHeader', () => {
  it('names the phone client by its path', () => {
    expect(clientHeader('/termag/m/sessions', 'abc1234def56')).toBe('mobile/abc1234def56');
    expect(clientHeader('/termag/', 'abc1234def56')).toBe('web/abc1234def56');
    expect(clientHeader('/termag/admin/fleet', 'unknown')).toBe('web/unknown');
    expect(clientHeader('/termag/m', 'abc1234def56')).toBe('mobile/abc1234def56');
    // A workspace deep link that merely starts with "m" is not the phone client.
    expect(clientHeader('/termag/main-project', 'abc1234def56')).toBe('web/abc1234def56');
  });
});

describe('sendClientHeader', () => {
  it('names this page on every request of the instance', async () => {
    const instance = axios.create();
    sendClientHeader(instance);
    const location = { pathname: '/termag/m/sessions' };
    vi.stubGlobal('location', location);
    try {
      const sent: (string | undefined)[] = [];
      const adapter = async (config: InternalAxiosRequestConfig) => {
        sent.push(config.headers.get('X-Termag-Client') as string | undefined);
        return { data: null, status: 204, statusText: 'No Content', headers: {}, config };
      };
      await instance.get('/termag/api/x', { adapter });
      location.pathname = '/termag/';
      await instance.get('/termag/api/x', { adapter });
      expect(sent).toEqual([`mobile/${BUILD_SHA}`, `web/${BUILD_SHA}`]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
