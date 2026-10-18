import { describe, expect, it } from 'vitest';
import { isValidBoxName } from './boxNames';
import {
  PROJECT_NAME_ERROR,
  RESERVED_PROJECT_NAME_ERROR,
  boxNameConflictMessage,
  boxNameFromProject,
  boxNameTaken,
  projectNameError,
} from './newProjectBox';

describe('projectNameError', () => {
  it('accepts the same charset a box name uses', () => {
    expect(projectNameError('proj-fuzzy-pants')).toBe('');
    expect(projectNameError('  webapp  ')).toBe('');
    expect(isValidBoxName('proj-fuzzy-pants')).toBe(true);
  });

  it('uses the project route sentence for an illegal name', () => {
    expect(projectNameError('foo bar')).toBe(PROJECT_NAME_ERROR);
    expect(projectNameError('')).toBe('');
  });

  it('reserves MetaTerm without regard to case', () => {
    expect(projectNameError('MetaTerm')).toBe(RESERVED_PROJECT_NAME_ERROR);
    expect(projectNameError('metaterm')).toBe(RESERVED_PROJECT_NAME_ERROR);
  });
});

describe('boxNameFromProject', () => {
  it('keeps a valid project name unchanged', () => {
    expect(boxNameFromProject(' webapp ')).toBe('webapp');
  });

  it('derives a box name when the project name is not a legal box name', () => {
    expect(boxNameFromProject('My Repo')).toBe('My-Repo');
    expect(boxNameFromProject('...')).toBe('');
  });
});

describe('boxNameTaken', () => {
  const boxes = [
    { name: 'webapp', status: 'ready', kind: 'ec2' },
    { name: 'old', status: 'terminated', kind: 'ec2' },
    { name: 'broken', status: 'failed', kind: 'ec2' },
    { name: 'external-failed', status: 'failed', kind: 'external' },
  ];

  it('blocks a live box and ignores a terminated one', () => {
    expect(boxNameTaken('webapp', boxes)?.status).toBe('ready');
    expect(boxNameTaken('old', boxes)).toBeUndefined();
    expect(boxNameTaken('  ', boxes)).toBeUndefined();
  });

  it('does not treat a failed EC2 box as taken, and does not rename it', () => {
    expect(boxNameTaken('broken', boxes)).toBeUndefined();
    expect(boxNameTaken('external-failed', boxes)?.kind).toBe('external');
    expect(boxNameConflictMessage('webapp')).toBe('A box named "webapp" already exists');
    expect(boxNameFromProject('webapp')).toBe('webapp');
  });
});
