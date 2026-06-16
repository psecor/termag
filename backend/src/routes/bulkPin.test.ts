import { describe, it, expect } from 'vitest';
import { parseBulkPinBody } from './bulkPin';

describe('parseBulkPinBody', () => {
  it('accepts a valid pin request', () => {
    expect(parseBulkPinBody({ projectIds: ['a', 'b'], pinned: true }))
      .toEqual({ projectIds: ['a', 'b'], pinned: true });
  });

  it('accepts a valid unpin request', () => {
    expect(parseBulkPinBody({ projectIds: ['a'], pinned: false }))
      .toEqual({ projectIds: ['a'], pinned: false });
  });

  it('de-duplicates repeated ids', () => {
    expect(parseBulkPinBody({ projectIds: ['a', 'a', 'b'], pinned: true }))
      .toEqual({ projectIds: ['a', 'b'], pinned: true });
  });

  it('rejects an empty projectIds array', () => {
    expect(parseBulkPinBody({ projectIds: [], pinned: true }))
      .toHaveProperty('error');
  });

  it('rejects projectIds that is not an array', () => {
    expect(parseBulkPinBody({ projectIds: 'a', pinned: true })).toHaveProperty('error');
    expect(parseBulkPinBody({ pinned: true })).toHaveProperty('error');
    expect(parseBulkPinBody({ projectIds: null, pinned: true })).toHaveProperty('error');
  });

  it('rejects non-string elements in projectIds', () => {
    expect(parseBulkPinBody({ projectIds: [1, {}], pinned: true })).toHaveProperty('error');
    expect(parseBulkPinBody({ projectIds: ['a', 2], pinned: true })).toHaveProperty('error');
  });

  it('rejects a missing or non-boolean pinned', () => {
    expect(parseBulkPinBody({ projectIds: ['a'] })).toHaveProperty('error');
    expect(parseBulkPinBody({ projectIds: ['a'], pinned: 'true' })).toHaveProperty('error');
    expect(parseBulkPinBody({ projectIds: ['a'], pinned: 1 })).toHaveProperty('error');
  });

  it('rejects a non-object body', () => {
    expect(parseBulkPinBody(null)).toHaveProperty('error');
    expect(parseBulkPinBody('x')).toHaveProperty('error');
    expect(parseBulkPinBody(['a'])).toHaveProperty('error');
  });
});
