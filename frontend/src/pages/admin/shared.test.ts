import { describe, it, expect } from 'vitest';
import { errorText, pendingText, refreshFailedText } from './shared';

describe('pendingText', () => {
  it('reads loading until a fetch has failed', () => {
    expect(pendingText({ error: null })).toBe('loading…');
  });
  it('shows the failure with the status and server message', () => {
    const err = { response: { status: 500, data: { error: 'Internal error' } }, message: 'Request failed with status code 500' };
    expect(pendingText({ error: err })).toBe('failed to load: 500 Internal error · retrying');
  });
});

describe('errorText', () => {
  it('uses the status text when the body has no error, never axios\'s repeat of the status', () => {
    const err = { response: { status: 500, statusText: 'Internal Server Error', data: '<html>' }, message: 'Request failed with status code 500' };
    expect(errorText(err)).toBe('500 Internal Server Error');
    expect(errorText({ response: { status: 429 }, message: 'Request failed with status code 429' })).toBe('429');
  });
  it('is the message for a failure with no response, else a generic one', () => {
    expect(errorText(new Error('Network Error'))).toBe('Network Error');
    expect(errorText(null)).toBe('request failed');
  });
});

describe('refreshFailedText', () => {
  it('is empty without an error and names the failure with one', () => {
    expect(refreshFailedText(null)).toBe('');
    expect(refreshFailedText({ response: { status: 503, data: { error: 'Agent offline' } } })).toBe(' · refresh failed: 503 Agent offline, retrying');
  });
});
