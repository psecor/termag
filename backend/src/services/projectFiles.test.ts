/**
 * The pure rules of Project files and My files (services/projectFiles.ts):
 * the names, the grant decision, one space to one role, and the `files.saved`
 * attributes, which never carry a path or a file name.
 */
import { describe, expect, it } from 'vitest';
import { PROJECT_FILES_CAPABILITY as SENT_ONLY_TO, chatSendRpcPayload } from './chatRunner';
import {
  PROJECT_FILES_CAPABILITY, SPACE_NAME_MAX, fileKind, filesMovedDetail, filesSavedDetail, grantPlan, isFilesCrossover, isCapable, myFilesName, nameSlug,
  projectFilesName, savedBy, spaceInUseReason,
} from './projectFiles';

const SPACE_NAME = /^[a-z0-9-]{2,40}$/;

describe('naming', () => {
  it('is <unix user>-<project slug>, lowercased, with anything outside [a-z0-9] as one dash', () => {
    expect(projectFilesName('ana', 'termag')).toBe('ana-termag');
    expect(projectFilesName('ana', 'termag + termag-desktop')).toBe('ana-termag-termag-desktop');
    expect(projectFilesName('ana', '  Q3 Reports!! ')).toBe('ana-q3-reports');
    expect(projectFilesName('ana.b_c', 'X')).toBe('ana-b-c-x');
    expect(projectFilesName('ana', '🚀')).toBe('ana-project');
    expect(nameSlug('--A  b--')).toBe('a-b');
  });

  it('adds -2, -3 on a clash, and cuts so the whole name, suffix included, is at most 40', () => {
    expect(projectFilesName('ana', 'termag', 2)).toBe('ana-termag-2');
    expect(projectFilesName('ana', 'termag', 13)).toBe('ana-termag-13');
    const long = 'a very long project name that keeps going and going';
    for (const n of [1, 2, 10, 50]) {
      const name = projectFilesName('jonnyd', long, n);
      expect(name.length).toBeLessThanOrEqual(SPACE_NAME_MAX);
      expect(name).toMatch(SPACE_NAME);
      if (n > 1) expect(name.endsWith(`-${n}`)).toBe(true);
    }
    expect(projectFilesName('jonnyd', long)).toBe('jonnyd-a-very-long-project-name-that-kee');
    // The cut never leaves a dash before the suffix.
    // 'ana-' and 33 x's are 37 characters, so the 38 that '-2' leaves end on the dash before 'tail', which goes.
    expect(projectFilesName('ana', 'x'.repeat(33) + ' tail', 2)).toBe(`ana-${'x'.repeat(33)}-2`);
    expect(projectFilesName('ana', 'x'.repeat(31) + ' tail', 2)).toBe(`ana-${'x'.repeat(31)}-ta-2`);
  });

  it('names My files <unix user>-my-files, cutting the user part', () => {
    expect(myFilesName('ana')).toBe('ana-my-files');
    expect(myFilesName('ana', 2)).toBe('ana-my-files-2');
    const name = myFilesName('u'.repeat(60), 3);
    expect(name).toBe(`${'u'.repeat(29)}-my-files-3`);
    expect(name.length).toBe(SPACE_NAME_MAX);
    expect(myFilesName('___')).toBe('user-my-files');
  });
});

describe('grants', () => {
  it('go only to a box that announces project-files-v1, with the flags on; My files only while it is on', () => {
    expect(grantPlan({ capable: false, enabled: true, myFilesOnBoxes: true })).toEqual({ projectFiles: false, myFiles: false });
    expect(grantPlan({ capable: true, enabled: false, myFilesOnBoxes: true })).toEqual({ projectFiles: false, myFiles: false });
    expect(grantPlan({ capable: true, enabled: true, myFilesOnBoxes: true })).toEqual({ projectFiles: true, myFiles: true });
    expect(grantPlan({ capable: true, enabled: true, myFilesOnBoxes: false })).toEqual({ projectFiles: true, myFiles: false });
  });

  it('reads the capability the agent announces, the one the turn payload is gated on', () => {
    expect(PROJECT_FILES_CAPABILITY).toBe('project-files-v1');
    expect(SENT_ONLY_TO).toBe(PROJECT_FILES_CAPABILITY);
    expect(isCapable(['chat-runner-v1', 'project-files-v1'])).toBe(true);
    expect(isCapable(['chat-runner-v1'])).toBe(false);
    expect(isCapable(undefined)).toBe(false);
  });
});

describe('one space, one role', () => {
  const none = { projectId: null, myFilesOf: [] };
  it('refuses a space that is another project\'s files or anyone\'s My files', () => {
    expect(spaceInUseReason({ kind: 'project', userProjectId: 'p1' }, none)).toBeNull();
    expect(spaceInUseReason({ kind: 'project', userProjectId: 'p1' }, { projectId: 'p1', myFilesOf: [] })).toBeNull();
    expect(spaceInUseReason({ kind: 'project', userProjectId: 'p1' }, { projectId: 'p2', myFilesOf: [] })).toMatch(/project's files/);
    expect(spaceInUseReason({ kind: 'project', userProjectId: 'p1' }, { projectId: null, myFilesOf: ['u1'] })).toMatch(/My files/);
    expect(spaceInUseReason({ kind: 'mine', userId: 'u1' }, { projectId: null, myFilesOf: ['u1'] })).toBeNull();
    expect(spaceInUseReason({ kind: 'mine', userId: 'u1' }, { projectId: null, myFilesOf: ['u2'] })).toMatch(/My files/);
    expect(spaceInUseReason({ kind: 'mine', userId: 'u1' }, { projectId: 'p1', myFilesOf: [] })).toMatch(/project's files/);
  });
});

describe('files.saved', () => {
  it('says the kind from the extension alone', () => {
    expect(fileKind('screenshots/run.PNG')).toBe('image');
    expect(fileKind('reports/q3.md')).toBe('text');
    expect(fileKind('data/rows.csv')).toBe('data');
    expect(fileKind('build/dist.tar.gz')).toBe('archive');
    expect(fileKind('docs/spec.pdf')).toBe('other');
    expect(fileKind('Makefile')).toBe('other');
    expect(fileKind('.env')).toBe('other');
    expect(fileKind('a.dir/noext')).toBe('other');
  });

  it('says who by the credential, and carries no path or name', () => {
    const box = { kind: 'box' as const, userId: 'u1', instanceId: 'b1' };
    const person = { kind: 'user' as const, userId: 'u1' };
    expect(savedBy(box)).toBe('agent');
    expect(savedBy(person)).toBe('person');
    const detail = filesSavedDetail({ location: 'project-files', caller: box, chosen: 'default', path: 'secret-plans/acme.png' });
    expect(detail).toEqual({ location: 'project-files', by: 'agent', chosen: 'default', kind: 'image' });
    expect(JSON.stringify(detail)).not.toMatch(/secret|acme/);
  });
});

describe('a chat turn\'s files', () => {
  const chat = {
    chatKey: 'p1--main', cwd: '/w/p1', projectId: 'p1', workstream: 'main', workstreamId: 'ws1', requireCheckout: false, permissionMode: 'default',
  };
  const files = { project: 'ana-termag', mine: 'ana-my-files' };
  it('go only to an agent that sets TERMAG_SPACE and TERMAG_MY_FILES from them', () => {
    expect(chatSendRpcPayload(chat, 'hi', ['chat-runner-v1', PROJECT_FILES_CAPABILITY], { files }).files).toEqual(files);
    expect(chatSendRpcPayload(chat, 'hi', ['chat-runner-v1'], { files })).not.toHaveProperty('files');
    expect(chatSendRpcPayload(chat, 'hi', ['chat-runner-v1', PROJECT_FILES_CAPABILITY])).not.toHaveProperty('files');
  });
});

describe('files.moved', () => {
  it('counts only a move between Project files and My files, either way', () => {
    expect(isFilesCrossover('project-files', 'my-files')).toBe(true);
    expect(isFilesCrossover('my-files', 'project-files')).toBe(true);
    expect(isFilesCrossover('project-files', 'project-files')).toBe(false);
    expect(isFilesCrossover('my-files', 'my-files')).toBe(false);
    expect(isFilesCrossover('other', 'my-files')).toBe(false);
    expect(isFilesCrossover('project-files', 'other')).toBe(false);
  });

  it('says from and to, who moved it, who saved it and how long ago, and no path', () => {
    const person = { kind: 'user' as const, userId: 'u1' };
    const at = new Date(Date.UTC(2026, 10, 13, 10));
    const now = Date.UTC(2026, 10, 13, 12, 30);
    expect(filesMovedDetail({ from: 'project-files', to: 'my-files', caller: person, saved: { byBox: true, at }, now }))
      .toEqual({ from: 'project-files', to: 'my-files', by: 'person', savedBy: 'agent', ageHours: 2.5 });
    expect(filesMovedDetail({ from: 'my-files', to: 'project-files', caller: { kind: 'box', userId: 'u1', instanceId: 'b1' }, saved: null, now }))
      .toEqual({ from: 'my-files', to: 'project-files', by: 'agent', savedBy: null, ageHours: null });
  });
});

