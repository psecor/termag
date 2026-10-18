import { describe, expect, it } from 'vitest';
import {
  canRemoveBox, isReadOnly, resolveSpaceAccess, roleAtLeast, wouldRemoveLastOwner, type AccessFacts, type SpaceRole,
} from './spaceAccess';
import { MAX_INHERITANCE_HOPS, ancestorsOf, childBoxesOf, parentBoxOf, type InheritanceBox } from './spaceInheritance';

const space = { id: 's1', readOnlyAt: null, deletedAt: null };

function facts(members: Record<string, SpaceRole>, granted: string[] = [], extra: Partial<AccessFacts> = {}): AccessFacts {
  return { space, members: new Map(Object.entries(members)), grantedBoxIds: new Set(granted), ...extra };
}

const aliceBox: InheritanceBox = { id: 'b1', userId: 'alice', status: 'ready' };

describe('roles', () => {
  it('orders viewer < editor < owner', () => {
    expect(roleAtLeast('owner', 'editor')).toBe(true);
    expect(roleAtLeast('editor', 'editor')).toBe(true);
    expect(roleAtLeast('viewer', 'editor')).toBe(false);
  });
});

describe('resolveSpaceAccess for a user', () => {
  it('is the member role', () => {
    expect(resolveSpaceAccess({ kind: 'user', userId: 'bob' }, facts({ alice: 'owner', bob: 'editor' })))
      .toEqual({ role: 'editor', memberRole: 'editor', readOnly: false });
  });

  it('is nothing for a non-member', () => {
    expect(resolveSpaceAccess({ kind: 'user', userId: 'eve' }, facts({ alice: 'owner' }))).toBeNull();
  });

  it('is nothing for a deleted space', () => {
    expect(resolveSpaceAccess({ kind: 'user', userId: 'alice' }, { ...facts({ alice: 'owner' }), space: { ...space, deletedAt: new Date() } })).toBeNull();
  });

  it('caps every role at viewer when the space has no owner', () => {
    const a = resolveSpaceAccess({ kind: 'user', userId: 'bob' }, facts({ bob: 'editor' }));
    expect(a).toEqual({ role: 'viewer', memberRole: 'editor', readOnly: true });
  });

  it('caps every role at viewer when readOnlyAt is set', () => {
    const f = { ...facts({ alice: 'owner' }), space: { ...space, readOnlyAt: new Date() } };
    expect(resolveSpaceAccess({ kind: 'user', userId: 'alice' }, f)?.role).toBe('viewer');
  });
});

describe('resolveSpaceAccess for a box', () => {
  const caller = { kind: 'box' as const, userId: 'alice', instanceId: 'b1' };

  it('acts with its owner\'s role when granted explicitly', () => {
    expect(resolveSpaceAccess(caller, facts({ alice: 'editor', carol: 'owner' }, ['b1'], { box: aliceBox })))
      .toEqual({ role: 'editor', memberRole: 'editor', readOnly: false, boxAccess: { kind: 'explicit' } });
  });

  it('follows the owner\'s current role, down to viewer', () => {
    expect(resolveSpaceAccess(caller, facts({ alice: 'viewer', carol: 'owner' }, ['b1'], { box: aliceBox }))?.role).toBe('viewer');
  });

  it('is nothing without a grant', () => {
    expect(resolveSpaceAccess(caller, facts({ alice: 'owner' }, [], { box: aliceBox }))).toBeNull();
  });

  it('is nothing once the owner is no longer a member, grant or not', () => {
    expect(resolveSpaceAccess(caller, facts({ carol: 'owner' }, ['b1'], { box: aliceBox }))).toBeNull();
  });

  it('is nothing for a terminated box', () => {
    expect(resolveSpaceAccess(caller, facts({ alice: 'owner' }, ['b1'], { box: { ...aliceBox, status: 'terminated' } }))).toBeNull();
  });

  it('is nothing when the token\'s box is not the box loaded', () => {
    expect(resolveSpaceAccess(caller, facts({ alice: 'owner' }, ['b2'], { box: { ...aliceBox, id: 'b2' } }))).toBeNull();
  });

  it('inherits from a granted ancestor, and says through which', () => {
    const child = { id: 'b9', userId: 'alice', status: 'ready' };
    const a = resolveSpaceAccess({ ...caller, instanceId: 'b9' }, facts({ alice: 'owner' }, ['b1'], { box: child, ancestors: [aliceBox] }));
    expect(a?.boxAccess).toEqual({ kind: 'inherited', via: 'b1' });
  });

  it('does not inherit through a terminated or differently-owned ancestor', () => {
    const child = { id: 'b9', userId: 'alice', status: 'ready' };
    const c9 = { ...caller, instanceId: 'b9' };
    expect(resolveSpaceAccess(c9, facts({ alice: 'owner' }, ['b1'], { box: child, ancestors: [{ ...aliceBox, status: 'terminated' }] }))).toBeNull();
    expect(resolveSpaceAccess(c9, facts({ alice: 'owner' }, ['b1'], { box: child, ancestors: [{ ...aliceBox, userId: 'bob' }] }))).toBeNull();
  });
});

describe('membership rules', () => {
  const members = new Map<string, SpaceRole>([['alice', 'owner'], ['bob', 'editor']]);

  it('refuses to remove or demote the last owner', () => {
    expect(wouldRemoveLastOwner(members, 'alice', null)).toBe(true);
    expect(wouldRemoveLastOwner(members, 'alice', 'editor')).toBe(true);
    expect(wouldRemoveLastOwner(members, 'alice', 'owner')).toBe(false);
    expect(wouldRemoveLastOwner(members, 'bob', null)).toBe(false);
    expect(wouldRemoveLastOwner(new Map([...members, ['carol', 'owner']]), 'alice', null)).toBe(false);
  });

  it('lets a box owner or a space owner remove a box', () => {
    const editor = { role: 'editor' as const, memberRole: 'editor' as const, readOnly: false };
    const owner = { role: 'owner' as const, memberRole: 'owner' as const, readOnly: false };
    expect(canRemoveBox(editor, 'bob', 'bob')).toBe(true);
    expect(canRemoveBox(editor, 'bob', 'alice')).toBe(false);
    expect(canRemoveBox(owner, 'alice', 'bob')).toBe(true);
    expect(canRemoveBox({ ...owner, role: 'viewer', readOnly: true }, 'alice', 'alice')).toBe(false);
  });

  it('reads a space with no owner as read-only', () => {
    expect(isReadOnly(space, new Map([['bob', 'editor']]))).toBe(true);
    expect(isReadOnly(space, members)).toBe(false);
  });
});

describe('inheritance seam', () => {
  it('gives every box no parent until the ask thread link lands', () => {
    expect(parentBoxOf(aliceBox, {})).toBeNull();
    expect(childBoxesOf('b1', [aliceBox, { id: 'b2', userId: 'alice', status: 'ready' }], {})).toEqual([]);
  });

  it('walks no ancestors', async () => {
    let loads = 0;
    expect(await ancestorsOf(aliceBox, async () => { loads++; return null; }, {})).toEqual([]);
    expect(loads).toBe(0);
  });

  it('caps the walk at eight hops', () => {
    expect(MAX_INHERITANCE_HOPS).toBe(8);
  });
});
