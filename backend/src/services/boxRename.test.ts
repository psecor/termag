import { describe, expect, it, vi } from 'vitest';

vi.mock('./featureFlags', () => ({ boolVariation: vi.fn() }));

const { BOX_NAME_ERROR } = await import('./boxNames');
const { boxTokenName, checkBoxRename } = await import('./boxRename');

const box = { name: 'devbox', status: 'ready' };

describe('checkBoxRename', () => {
  it('takes a valid new name, trimmed', () => {
    expect(checkBoxRename(box, '  heavy_2 ')).toEqual({ ok: true, name: 'heavy_2', unchanged: false });
  });

  it('says when the name is the one the box already has', () => {
    expect(checkBoxRename(box, 'devbox')).toEqual({ ok: true, name: 'devbox', unchanged: true });
  });

  it('works on a parked or provisioning box', () => {
    for (const status of ['stopped', 'hibernated', 'provisioning', 'failed']) {
      expect(checkBoxRename({ ...box, status }, 'heavy'), status).toMatchObject({ ok: true });
    }
  });

  it('needs a name', () => {
    for (const raw of [undefined, null, 7, '', '   ']) {
      expect(checkBoxRename(box, raw), String(raw)).toEqual({ ok: false, status: 400, error: 'name required' });
    }
  });

  it('holds a new name to the create rule, even for a box named before it', () => {
    for (const raw of ['my box', 'a/b', 'box.1', 'café']) {
      expect(checkBoxRename({ ...box, name: 'old name' }, raw), raw).toEqual({ ok: false, status: 400, error: BOX_NAME_ERROR });
    }
  });

  it('answers a missing or terminated box as not found', () => {
    expect(checkBoxRename(null, 'heavy')).toEqual({ ok: false, status: 404, error: 'Box not found' });
    expect(checkBoxRename({ ...box, status: 'terminated' }, 'heavy')).toEqual({ ok: false, status: 404, error: 'Box not found' });
  });

  it('checks the name before the box, so a bad request never says whether a box exists', () => {
    expect(checkBoxRename(null, 'a/b')).toMatchObject({ status: 400 });
  });
});

describe('boxTokenName', () => {
  it('is the label a box token is created with', () => {
    expect(boxTokenName('devbox')).toBe('box: devbox');
  });
});
