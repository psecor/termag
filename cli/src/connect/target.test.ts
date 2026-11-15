import { describe, expect, it } from 'vitest';
import { parseRef, pickBox, pickProxyBox, ssmTarget, type ConnectBox } from './target.js';

function box(state: string, name = 'devbox'): ConnectBox {
  return {
    id: `id-${name}`, name, addressable: true, kind: 'ec2', flavor: 'full', state, status: state,
    agentConnected: false, error: null, projects: [], ec2InstanceId: 'i-0abc', region: 'us-east-2',
  };
}

describe('parseRef', () => {
  it('needs a box unless the command takes a default one', () => {
    expect(() => parseRef(undefined)).toThrow('Name a box');
    expect(parseRef(undefined, { defaultBox: true })).toEqual({ box: null, project: null });
    expect(parseRef('devbox/fix', { defaultBox: true })).toEqual({ box: 'devbox', project: 'fix' });
  });
});

describe('pickBox', () => {
  it('takes the only box when none is named', () => {
    expect(pickBox([box('running')], null).name).toBe('devbox');
  });

  it('asks for a name when there are several boxes', () => {
    expect(() => pickBox([box('running'), box('stopped', 'other')], null))
      .toThrow('You have 2 boxes (devbox, other); name the one to use');
  });

  it('says there is no box to default to', () => {
    expect(() => pickBox([], null)).toThrow('You have no boxes; create one with `termag box create <name>`');
  });

  it('finds a named box by name or id', () => {
    const boxes = [box('running'), box('stopped', 'other')];
    expect(pickBox(boxes, 'other').name).toBe('other');
    expect(pickBox(boxes, 'id-devbox').name).toBe('devbox');
  });

  // OpenSSH lowercases the host before ssh-proxy sees it (`%h`).
  it('finds a box whatever the case of its name, as ssh-proxy is handed it', () => {
    const boxes = [box('running', 'Alice_Termag'), box('running', 'other')];
    expect(pickBox(boxes, 'alice_termag').name).toBe('Alice_Termag');
    expect(pickBox(boxes, 'ALICE_TERMAG').name).toBe('Alice_Termag');
  });

  it('prefers the exact name over one that differs only in case', () => {
    const boxes = [box('running', 'Devbox'), box('running', 'devbox')];
    expect(pickBox(boxes, 'devbox').id).toBe('id-devbox');
    expect(pickBox(boxes, 'Devbox').id).toBe('id-Devbox');
  });

  it('refuses a name that matches several boxes only when case is ignored', () => {
    const boxes = [box('running', 'Devbox'), box('running', 'DevBox')];
    expect(() => pickBox(boxes, 'devbox'))
      .toThrow('"devbox" matches 2 boxes (Devbox, DevBox) when case is ignored; name one exactly, or by id');
  });

  it('still says which boxes there are when nothing matches', () => {
    expect(() => pickBox([box('running', 'Alice_Termag')], 'nope'))
      .toThrow('No box named "nope"; your boxes: Alice_Termag');
  });
});

describe('ssmTarget', () => {
  it('targets a running box in its own region', () => {
    expect(ssmTarget(box('running'), 'us-west-2')).toEqual({ instanceId: 'i-0abc', region: 'us-east-2' });
  });

  it('says how to resume a hibernated box', () => {
    expect(() => ssmTarget(box('hibernated'), 'us-east-2'))
      .toThrow('devbox is hibernated; resume it (`termag box start devbox` or the web UI)');
  });

  it('says a hibernating box can be resumed once it has hibernated', () => {
    expect(() => ssmTarget(box('hibernating'), 'us-east-2'))
      .toThrow('devbox is hibernating; once it is hibernated, resume it with `termag box start devbox`');
  });

  it('keeps the generic message for other transitional states', () => {
    expect(() => ssmTarget(box('starting'), 'us-east-2')).toThrow('devbox is starting; try again once it is running');
  });
});

describe('pickProxyBox (what ssh-proxy is handed as %h)', () => {
  const at = (name: string, id: string): ConnectBox => ({ ...box('running', name), ec2InstanceId: id });
  const boxes = [at('Devbox', 'i-0aaaaaaaaaaaaaaaa'), at('devbox', 'i-0bbbbbbbbbbbbbbbb'), at('Alice_Termag', 'i-0cccccccc')];

  it('finds the box by instance id, the HostName ssh-config writes, whatever its name', () => {
    expect(pickProxyBox(boxes, 'i-0aaaaaaaaaaaaaaaa').name).toBe('Devbox');
    expect(pickProxyBox(boxes, 'i-0bbbbbbbbbbbbbbbb').name).toBe('devbox');
    expect(pickProxyBox(boxes, 'I-0CCCCCCCC').name).toBe('Alice_Termag');
  });

  it('says to rewrite the ssh config when no box has the instance id', () => {
    expect(() => pickProxyBox(boxes, 'i-0dddddddd')).toThrow(
      'No box of yours is instance i-0dddddddd (your boxes: Devbox, devbox, Alice_Termag); run `termag ssh-config --install` again');
  });

  // An older block's %h is termag-<box>, lowercased by OpenSSH.
  it("finds an older block's lowercased alias when only one box has that name in any case", () => {
    expect(pickProxyBox(boxes, 'termag-alice_termag').name).toBe('Alice_Termag');
  });

  it('refuses a lowercased alias two boxes share, rather than take the exact match ssh may have made', () => {
    expect(() => pickProxyBox(boxes, 'termag-devbox')).toThrow(
      '"devbox" matches 2 boxes (Devbox, devbox) and ssh has lowercased it, so termag can\'t tell which;'
      + ' run `termag ssh-config --install` again, which names each box by its instance id');
  });
});
