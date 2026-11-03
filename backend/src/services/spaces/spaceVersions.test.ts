import { describe, expect, it } from 'vitest';
import { changedBody, currentConflict, landedCheck, sameEtag, type ObjectVersionInfo } from './spaceVersions';

const v = (versionId: string, etag: string | null, deleteMarker = false): ObjectVersionInfo => ({ versionId, etag, lastModified: null, deleteMarker });

describe('currentConflict', () => {
  it('passes the version read, and a new file that is new', () => {
    expect(currentConflict({ ifMatch: '"a"' }, { etag: '"a"' })).toBeNull();
    expect(currentConflict({ ifMatch: '"a"' }, { etag: 'a' })).toBeNull();
    expect(currentConflict({ ifNoneMatch: '*' }, null)).toBeNull();
    expect(currentConflict(null, { etag: '"b"' })).toBeNull();
  });
  it('names what the file is now otherwise', () => {
    expect(currentConflict({ ifMatch: '"a"' }, { etag: '"b"' })).toEqual({ now: '"b"' });
    expect(currentConflict({ ifMatch: '"a"' }, null)).toEqual({ now: null });
    expect(currentConflict({ ifNoneMatch: '*' }, { etag: '"b"' })).toEqual({ now: '"b"' });
  });
  it('compares ETags without quotes or a weak prefix', () => {
    expect(sameEtag('W/"x"', 'x')).toBe(true);
    expect(sameEtag('"x"', '"y"')).toBe(false);
  });
});

describe('landedCheck', () => {
  it('passes a write that replaced the version read', () => {
    expect(landedCheck({ ifMatch: '"a"' }, [v('v2', '"ours"'), v('v1', '"a"')], '"ours"')).toEqual({ ok: true });
    expect(landedCheck({ ifNoneMatch: '*' }, [v('v1', '"ours"')], '"ours"')).toEqual({ ok: true });
    expect(landedCheck({ ifNoneMatch: '*' }, [v('v2', '"ours"'), v('dm', null, true), v('v1', '"old"')], '"ours"')).toEqual({ ok: true });
  });
  it('puts back the version a write landed on by mistake, while ours is still current', () => {
    expect(landedCheck({ ifMatch: '"a"' }, [v('v3', '"ours"'), v('v2', '"theirs"'), v('v1', '"a"')], '"ours"'))
      .toEqual({ ok: false, now: '"theirs"', restore: { kind: 'version', versionId: 'v2' } });
    // A new file that someone else made first: removing ours brings theirs back.
    expect(landedCheck({ ifNoneMatch: '*' }, [v('v2', '"ours"'), v('v1', '"theirs"')], '"ours"'))
      .toEqual({ ok: false, now: '"theirs"', restore: { kind: 'version', versionId: 'v1' } });
    // The file was removed since it was read: the write stands (sweep 12: a confirm never removes).
    expect(landedCheck({ ifMatch: '"a"' }, [v('v3', '"ours"'), v('dm', null, true), v('v1', '"a"')], '"ours"')).toEqual({ ok: true });
  });
  it('restores nothing once a later write replaced ours', () => {
    expect(landedCheck({ ifMatch: '"a"' }, [v('v4', '"later"'), v('v3', '"ours"'), v('v2', '"theirs"')], '"ours"'))
      .toEqual({ ok: false, now: '"theirs"', restore: null });
  });
});

describe('changedBody', () => {
  it('says whose version is there now, and when', () => {
    const at = new Date('2026-10-27T10:00:00Z');
    expect(changedBody('team', 'a.md', { ifMatch: '"a"' }, '"b"', { by: 'bob@example.com', box: 'box-2', at }).error)
      .toBe('team:a.md changed since you read it (yours "a", now "b" by bob@example.com (box-2) at 2026-10-27T10:00:00.000Z)');
    expect(changedBody('team', 'a.md', { ifNoneMatch: '*' }, '"b"', null)).toEqual(expect.objectContaining({ error: 'team:a.md already exists (now "b")', yours: 'new', now: '"b"' }));
  });
});

describe('landedCheck never loses a write (Bugbot sweep 12, #769)', () => {
  const ok = { ok: true };

  it('a store without version history: the only version is ours, and it stays', () => {
    // Unversioned S3 lists the current object alone, with versionId "null".
    expect(landedCheck({ ifMatch: '"a"' }, [v('null', '"ours"')], '"ours"')).toEqual(ok);
    expect(landedCheck({ ifNoneMatch: '*' }, [v('null', '"ours"')], '"ours"')).toEqual(ok);
    // Nothing listed at all, or only our version with a real id (history cut short): nothing to compare with.
    expect(landedCheck({ ifMatch: '"a"' }, [], '"ours"')).toEqual(ok);
    expect(landedCheck({ ifMatch: '"a"' }, [v('v9', '"ours"')], '"ours"')).toEqual(ok);
  });

  it('a write it can\'t find among the versions, or whose ETag it doesn\'t know, is never undone', () => {
    expect(landedCheck({ ifMatch: '"a"' }, [v('v3', '"later"'), v('v2', '"theirs"'), v('v1', '"a"')], null)).toEqual(ok);
    expect(landedCheck({ ifMatch: '"a"' }, [v('v3', '"later"'), v('v2', '"theirs"'), v('v1', '"a"')], '"not-there"')).toEqual(ok);
  });

  it('the same writer retrying: its own identical versions are skipped', () => {
    expect(landedCheck({ ifMatch: '"a"' }, [v('v3', '"ours"'), v('v2', '"ours"'), v('v1', '"a"')], '"ours"')).toEqual(ok);
  });

  it('two quick writes by one client: the first confirm, arriving late, never reverts the second', () => {
    const versions = [v('v3', '"second"'), v('v2', '"first"'), v('v1', '"a"')];
    expect(landedCheck({ ifMatch: '"a"' }, versions, '"first"')).toEqual(ok);
    expect(landedCheck({ ifMatch: '"first"' }, versions, '"second"')).toEqual(ok);
  });

  it('a file removed after it was read: the write stands (a delete marker is no one\'s newer version)', () => {
    expect(landedCheck({ ifMatch: '"a"' }, [v('v3', '"ours"'), v('dm', null, true), v('v1', '"a"')], '"ours"')).toEqual(ok);
  });

  it('someone else writing the same bytes is no conflict', () => {
    expect(landedCheck({ ifMatch: '"a"' }, [v('v3', '"same"'), v('v2', '"same"'), v('v1', '"a"')], '"same"')).toEqual(ok);
  });

  it('restores only a newer, different version from someone else, while ours is current', () => {
    expect(landedCheck({ ifMatch: '"a"' }, [v('v3', '"ours"'), v('v2', '"theirs"'), v('v1', '"a"')], '"ours"'))
      .toEqual({ ok: false, now: '"theirs"', restore: { kind: 'version', versionId: 'v2' } });
    expect(landedCheck({ ifNoneMatch: '*' }, [v('v2', '"ours"'), v('v1', '"theirs"')], '"ours"'))
      .toEqual({ ok: false, now: '"theirs"', restore: { kind: 'version', versionId: 'v1' } });
    // Never a remove: no restore is ever a delete.
    for (const versions of [[v('v2', '"ours"'), v('dm', null, true)], [v('v2', '"ours"')]]) {
      const r = landedCheck({ ifMatch: '"a"' }, versions, '"ours"');
      expect(r.ok || (r as { restore: unknown }).restore === null || (r as { restore: { kind: string } }).restore.kind !== 'remove').toBe(true);
    }
  });
});
