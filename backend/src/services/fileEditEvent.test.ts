import { describe, expect, it } from 'vitest';
import { editDirOf, parseEditBody } from './fileEditEvent';

describe('editDirOf', () => {
  it('keeps the checkout top and one or two directory names', () => {
    expect(editDirOf('.')).toBe('.');
    expect(editDirOf('verifiers')).toBe('verifiers');
    expect(editDirOf('verifiers/billing')).toBe('verifiers/billing');
  });

  it('refuses a deeper path, a parent, an absolute path and anything with other characters', () => {
    for (const bad of ['a/b/c', '../etc', 'a/..', '/etc', 'a//b', '', 'a b', 'a/b,x=y', 'x'.repeat(65), 42, null]) {
      expect(editDirOf(bad), String(bad)).toBeNull();
    }
  });
});

describe('parseEditBody', () => {
  const ok = { session: 'jdoe-p-agent', dir: 'verifiers/billing', tool: 'Edit', claudeSession: '818686a7-4ce0-440a-ae11-522472afeecd' };

  it('keeps the session, directory, tool and Claude session', () => {
    expect(parseEditBody(ok)).toEqual(ok);
  });

  it('drops a bad Claude session but keeps the edit', () => {
    expect(parseEditBody({ ...ok, claudeSession: 'x,y=z' })).toEqual({ ...ok, claudeSession: null });
    expect(parseEditBody({ ...ok, claudeSession: undefined })).toEqual({ ...ok, claudeSession: null });
  });

  it('refuses a missing session, a bad directory and a tool that does not write files', () => {
    expect(parseEditBody({ ...ok, session: '' })).toHaveProperty('error');
    expect(parseEditBody({ ...ok, dir: 'a/b/c' })).toHaveProperty('error');
    expect(parseEditBody({ ...ok, tool: 'Bash' })).toHaveProperty('error');
    expect(parseEditBody(null)).toHaveProperty('error');
  });
});
