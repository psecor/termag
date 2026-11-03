import { describe, expect, it } from 'vitest';
import { AUTOMATIONS_SPACE_ROOT } from '../automations/spaceFolder';
import { AUTOMATIONS_ROOT, isMemoryEvent, isMemoryPath, lastWriters, logEntries, noteOf, pruneEventsWhere, putConditionOf, sinceOf } from './spaceMemory';
import type { SpaceEventRecord } from './spaceStore';

const ev = (id: string, action: string, path: string, at: number, extra: Partial<SpaceEventRecord> = {}): SpaceEventRecord =>
  ({ id, action, path, at: new Date(at), spaceId: 's', actorUserId: `u-${id}`, ...extra });
const actor = (e: SpaceEventRecord) => ({ userId: e.actorUserId, email: null, name: null, box: null });

describe('space memory paths', () => {
  it('is everything under .termag/ but its tools and skills (plan-outbox #50)', () => {
    expect(isMemoryPath('.termag/prompt.md')).toBe(true);
    expect(isMemoryPath('.termag/memory/a.md')).toBe(true);
    expect(isMemoryPath('.termag/skills/x/SKILL.md')).toBe(false);
    expect(isMemoryPath('.termag/skills/')).toBe(false);
    expect(isMemoryPath('.termag/tools/tracker/data.json')).toBe(false);
    expect(isMemoryPath('.termag/')).toBe(false);
    expect(isMemoryPath('tools/x')).toBe(false);
    expect(isMemoryPath('notes/.termag/a.md')).toBe(false);
  });

  it('counts a move by either side, and only file changes', () => {
    expect(isMemoryEvent({ action: 'file.mv', path: 'drafts/a.md -> .termag/memory/a.md' })).toBe(true);
    expect(isMemoryEvent({ action: 'file.mv', path: 'a.md -> b.md' })).toBe(false);
    expect(isMemoryEvent({ action: 'file.put', path: '.termag/skills/x/SKILL.md' })).toBe(false);
    expect(isMemoryEvent({ action: 'file.mv', path: '.termag/skills/x/SKILL.md -> .termag/memory/x.md' })).toBe(true);
    expect(isMemoryEvent({ action: 'file.get', path: '.termag/memory/a.md' })).toBe(false);
  });
});

describe("an automation's folder under .termag/automations/", () => {
  it('is the folder automations live in, and is not memory', () => {
    expect(AUTOMATIONS_ROOT).toBe(AUTOMATIONS_SPACE_ROOT);
    for (const p of ['.termag/automations/a1/memory/MEMORY.md', '.termag/automations/a1/state.json', '.termag/automations/a1/runs/run-20261028-0700.md', '.termag/automations/a1/README.md', '.termag/automations/']) {
      expect(isMemoryPath(p), p).toBe(false);
      expect(isMemoryEvent({ action: 'file.put', path: p }), p).toBe(false);
    }
    // A memory moved out of an automation's folder is a memory write; one moved in is a memory leaving.
    expect(isMemoryEvent({ action: 'file.mv', path: '.termag/automations/a1/x.md -> .termag/memory/x.md' })).toBe(true);
    expect(isMemoryEvent({ action: 'file.mv', path: '.termag/memory/x.md -> .termag/automations/a1/x.md' })).toBe(true);
  });

  it('keeps run logs out of the memory log and its writers', () => {
    const events = [
      ev('2', 'file.put', '.termag/automations/a1/runs/run-1.md', 2),
      ev('1', 'file.put', '.termag/memory/fact.md', 1),
    ];
    expect(logEntries(events, actor).map(e => e.path)).toEqual(['.termag/memory/fact.md']);
    expect(Object.keys(lastWriters(events, actor))).toEqual(['.termag/memory/fact.md']);
  });

  it('lets the 90-day prune take its events, as any other folder', () => {
    const where = JSON.stringify(pruneEventsWhere(new Date(0)));
    expect(where).toContain('{"NOT":{"path":{"startsWith":".termag/automations/"}}}');
    expect(where).toContain('{"NOT":{"path":{"contains":" -> .termag/automations/"}}}');
  });
});

describe('putConditionOf', () => {
  it('reads an ETag, quoted or not, or ifNoneMatch *', () => {
    expect(putConditionOf({})).toBeNull();
    expect(putConditionOf({ ifMatch: '"0a1b-2"' })).toEqual({ ifMatch: '"0a1b-2"' });
    expect(putConditionOf({ ifMatch: '0a1b' })).toEqual({ ifMatch: '"0a1b"' });
    expect(putConditionOf({ ifNoneMatch: '*' })).toEqual({ ifNoneMatch: '*' });
  });

  it('refuses anything else, so a header is never built from it', () => {
    expect(() => putConditionOf({ ifMatch: '"a"\r\nx-amz-acl: public' })).toThrow(/ETag/);
    expect(() => putConditionOf({ ifMatch: 5 })).toThrow(/ETag/);
    expect(() => putConditionOf({ ifNoneMatch: '"a"' })).toThrow(/\*/);
    expect(() => putConditionOf({ ifMatch: '"a"', ifNoneMatch: '*' })).toThrow(/not both/);
  });
});

describe('noteOf', () => {
  it('keeps one trimmed line', () => {
    expect(noteOf(undefined)).toBeNull();
    expect(noteOf('   ')).toBeNull();
    expect(noteOf(' merged two\n facts ')).toBe('merged two facts');
  });

  it('refuses a long note or one with a secret', () => {
    expect(() => noteOf('x'.repeat(201))).toThrow(/200/);
    expect(() => noteOf(`see ghp_${'z'.repeat(36)}`)).toThrow(/GitHub token/);
    expect(() => noteOf(['a'])).toThrow(/text/);
  });
});

describe('lastWriters', () => {
  it('takes the newest put of each memory path that is still there', () => {
    const events = [
      ev('5', 'file.put.signed', '.termag/memory/a.md', 5),
      ev('4', 'file.rm', '.termag/memory/b.md', 4),
      ev('3', 'file.put', '.termag/memory/b.md', 3),
      ev('2', 'file.put', '.termag/memory/a.md', 2, { versionId: 'v2', note: 'n' }),
      ev('1', 'file.put', '.termag/tools/t/data.json', 1),
      ev('0', 'file.mv', '.termag/memory/c.md -> .termag/memory/d.md', 0),
    ];
    const w = lastWriters(events, actor);
    // c.md moved to d.md: the move is d.md's last write (sweep 14).
    expect(Object.keys(w).sort()).toEqual(['.termag/memory/a.md', '.termag/memory/d.md']);
    expect(w['.termag/memory/a.md']).toEqual(expect.objectContaining({ userId: 'u-5', at: new Date(5).toISOString(), versionId: null }));
  });
});

describe('logEntries', () => {
  it('lists confirmed changes, not signings', () => {
    const entries = logEntries([ev('2', 'file.put.signed', '.termag/a.md', 2), ev('1', 'file.put', '.termag/a.md', 1, { bytes: 9n, note: 'why' })], actor);
    expect(entries).toEqual([expect.objectContaining({ action: 'file.put', path: '.termag/a.md', bytes: 9, note: 'why', userId: 'u-1' })]);
  });
});

describe('sinceOf', () => {
  it('reads durations and dates', () => {
    const now = Date.UTC(2026, 9, 27);
    expect(sinceOf(undefined, now)).toBeNull();
    expect(sinceOf('7d', now)!.getTime()).toBe(now - 7 * 86_400_000);
    expect(sinceOf('12h', now)!.getTime()).toBe(now - 12 * 3_600_000);
    expect(sinceOf('2026-10-01', now)!.toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(() => sinceOf('soon', now)).toThrow(/since/);
  });
});

describe('lastWriters after a move (Bugbot sweep 14, #769)', () => {
  it('credits the move, not an older write of the destination', () => {
    const events = [
      ev('3', 'file.mv', '.termag/memory/a.md -> .termag/memory/b.md', 3),
      ev('2', 'file.put', '.termag/memory/b.md', 2),
      ev('1', 'file.put', '.termag/memory/a.md', 1),
    ];
    const w = lastWriters(events, actor);
    expect(Object.keys(w)).toEqual(['.termag/memory/b.md']);
    expect(w['.termag/memory/b.md']).toEqual(expect.objectContaining({ userId: 'u-3', at: new Date(3).toISOString() }));
  });

  it('a delete or move of .termag/ itself clears every writer under it (Bugbot, #769: root folder delete leaves writers)', () => {
    const older = [ev('2', 'file.put', '.termag/memory/a.md', 2), ev('1', 'file.put', '.termag/prompt.md', 1)];
    expect(isMemoryEvent({ action: 'file.rm', path: '.termag/' })).toBe(true);
    expect(isMemoryEvent({ action: 'file.mv', path: '.termag/ -> old/' })).toBe(true);
    expect(isMemoryEvent({ action: 'file.mv', path: 'notes/ -> .termag/' })).toBe(true);
    expect(lastWriters([ev('3', 'file.rm', '.termag/', 3), ...older], actor)).toEqual({});
    expect(lastWriters([ev('3', 'file.mv', '.termag/ -> old/', 3), ...older], actor)).toEqual({});
    expect(lastWriters([ev('3', 'file.mv', 'notes/ -> .termag/', 3), ...older], actor)).toEqual({});
    // A write after the delete is the new memory's writer.
    expect(Object.keys(lastWriters([ev('4', 'file.put', '.termag/memory/b.md', 4), ev('3', 'file.rm', '.termag/', 3), ...older], actor))).toEqual(['.termag/memory/b.md']);
    // .termag/ is never a writer's path itself.
    expect(isMemoryPath('.termag/')).toBe(false);
  });

  it('a write after the move wins; a folder move clears what was under both sides', () => {
    expect(lastWriters([ev('4', 'file.put', '.termag/memory/b.md', 4), ev('3', 'file.mv', '.termag/memory/a.md -> .termag/memory/b.md', 3)], actor)['.termag/memory/b.md'])
      .toEqual(expect.objectContaining({ userId: 'u-4' }));
    const w = lastWriters([
      ev('3', 'file.mv', '.termag/x/ -> .termag/y/', 3),
      ev('2', 'file.put', '.termag/y/a.md', 2),
      ev('1', 'file.put', '.termag/x/a.md', 1),
    ], actor);
    expect(w).toEqual({});
  });
});
