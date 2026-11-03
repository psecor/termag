import { describe, it, expect } from 'vitest';
import { importedTeamsNote, parseTeamsExportFile, teamToText, textToMembers } from './prTeamText';

describe('textToMembers', () => {
  it('takes the login first, a trailing @ token as the email, and the rest as the name', () => {
    expect(textToMembers('lhenry Hal Brown')).toEqual({ members: [{ login: 'lhenry', name: 'Hal Brown' }] });
    expect(textToMembers('mons Fay Field fabian@x.com')).toEqual({ members: [{ login: 'mons', name: 'Fay Field', email: 'fabian@x.com' }] });
    expect(textToMembers('psmith p@x.com')).toEqual({ members: [{ login: 'psmith', email: 'p@x.com' }] });
  });
  it('ignores blanks and comments, lowercases and strips @', () => {
    expect(textToMembers('\n# a note\n@LHenry Hal Brown\n')).toEqual({ members: [{ login: 'lhenry', name: 'Hal Brown' }] });
  });
  it('rejects a bad login, and allows an empty list (clearing every override)', () => {
    expect(textToMembers('bad_login Some Name')).toHaveProperty('error');
    expect(textToMembers('')).toEqual({ members: [] });
  });
});

describe('teamToText', () => {
  it('is one login per line', () => {
    expect(teamToText(['lhenry', 'mons'])).toBe('lhenry\nmons');
  });
});

describe('parseTeamsExportFile (Import export…)', () => {
  it('takes the org-tree export', () => {
    const text = JSON.stringify({ teams: [{ tag: 'platform-team', label: 'Platform' }], members: { 'platform-team': { current: [], former: [] } } });
    expect(parseTeamsExportFile(text)).toEqual({ json: JSON.parse(text) });
  });
  it('says why another file is not one', () => {
    expect(parseTeamsExportFile('  ')).toEqual({ error: 'The file is empty' });
    expect(parseTeamsExportFile('{nope')).toMatchObject({ error: expect.stringMatching(/not JSON/) });
    expect(parseTeamsExportFile('[1,2]')).toMatchObject({ error: expect.stringMatching(/not a teams export/) });
    expect(parseTeamsExportFile('{"teams":[]}')).toMatchObject({ error: expect.stringMatching(/not a teams export/) });
    // As the docstring says, and the backend checks (Devin, #1094).
    expect(parseTeamsExportFile('{"teams":[],"members":{}}')).toMatchObject({ error: expect.stringMatching(/not a teams export/) });
    expect(parseTeamsExportFile('{"teams":[{"tag":"a"}],"members":[]}')).toMatchObject({ error: expect.stringMatching(/not a teams export/) });
  });
});

describe('importedTeamsNote', () => {
  it('counts what was imported and why some were skipped', () => {
    expect(importedTeamsNote({ teams: 75, members: 410, skipped: 12 })).toBe('Imported 75 teams and 410 memberships; 12 skipped (no GitHub login).');
    expect(importedTeamsNote({ teams: 1, members: 1, skipped: 0 })).toBe('Imported 1 team and 1 membership.');
  });
});
