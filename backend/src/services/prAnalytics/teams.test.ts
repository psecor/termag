import { describe, it, expect } from 'vitest';
import {
  descendantKeys, parseTeam, parseTeamMember, rosterInWindow, SEED_TEAM_MEMBERS, SEED_TEAMS,
  teamLogins, type StoredMembership,
} from './teams';

const d = (s: string) => new Date(`${s}T00:00:00Z`);
const m = (teamKey: string, login: string, start: string, end?: string, source: 'synced' | 'manual' = 'synced'): StoredMembership =>
  ({ teamKey, login, start: d(start), end: end ? d(end) : null, source });

describe('parseTeam', () => {
  it('normalises a valid team', () => {
    expect(parseTeam({ key: ' Platform-Team ', name: 'Platform', parent: 'ProductEng', hidden: true }))
      .toEqual({ key: 'platform-team', name: 'Platform', parent: 'producteng', hidden: true, sort: 100 });
  });
  it('defaults the name to the key and the parent to null', () => {
    expect(parseTeam({ key: 'platform-team' })).toEqual({ key: 'platform-team', name: 'platform-team', parent: null, hidden: false, sort: 100 });
  });
  it('rejects a bad key, a bad parent and a self-parent', () => {
    expect(parseTeam({ key: 'Bad Key!' })).toHaveProperty('error');
    expect(parseTeam({ key: 'x', parent: 'Bad Key!' })).toHaveProperty('error');
    expect(parseTeam({ key: 'x', parent: 'x' })).toHaveProperty('error');
  });
});

describe('parseTeamMember', () => {
  it('normalises a valid member, stripping @ and lowercasing', () => {
    expect(parseTeamMember({ login: '@Psmith', name: ' Pat Smith ', email: 'p@x.com', start: '2026-09-17' }))
      .toMatchObject({ login: 'psmith', name: 'Pat Smith', email: 'p@x.com', openStart: false });
  });
  it('takes openStart only when asked', () => {
    expect(parseTeamMember({ login: 'psmith', start: '2026-09-17' })).toMatchObject({ openStart: false });
    expect(parseTeamMember({ login: 'psmith', start: '2026-09-17', openStart: true })).toMatchObject({ openStart: true });
  });
  it('rejects a bad login, a missing date and an end before the start', () => {
    expect(parseTeamMember({ login: 'not a login', start: '2026-09-17' })).toHaveProperty('error');
    expect(parseTeamMember({ login: 'psmith' })).toHaveProperty('error');
    expect(parseTeamMember({ login: 'psmith', start: '2026-09-17', end: '2026-09-01' })).toHaveProperty('error');
  });
});

describe('descendantKeys', () => {
  const teams = [{ key: 'a', parent: null }, { key: 'b', parent: 'a' }, { key: 'c', parent: 'a' }, { key: 'd', parent: 'b' }, { key: 'z', parent: null }];
  it('returns the team and every descendant, breadth-first', () => {
    expect(descendantKeys(teams, 'a')).toEqual(['a', 'b', 'c', 'd']);
    expect(descendantKeys(teams, 'b')).toEqual(['b', 'd']);
    expect(descendantKeys(teams, 'z')).toEqual(['z']);
  });
  it('does not loop on a cycle', () => {
    expect(descendantKeys([{ key: 'a', parent: 'b' }, { key: 'b', parent: 'a' }], 'a')).toEqual(['a', 'b']);
  });
});

describe('rosterInWindow', () => {
  it('takes an open interval that overlaps and drops one that ended before', () => {
    const rows = [m('t', 'open', '2026-01-01'), m('t', 'left', '2026-01-01', '2026-03-01'), m('t', 'later', '2026-12-01')];
    expect(rosterInWindow(rows, d('2026-10-01'), d('2026-11-01'))).toEqual(['open']);
  });
  it('includes someone who left during the window and someone who joined during it', () => {
    const rows = [m('t', 'left', '2026-01-01', '2026-10-15'), m('t', 'joined', '2026-10-10')];
    expect(rosterInWindow(rows, d('2026-10-01'), d('2026-11-01'))).toEqual(['joined', 'left']);
  });
  it('handles a rejoin as two intervals, counting the login once', () => {
    const rows = [m('t', 'a', '2026-01-01', '2026-02-01'), m('t', 'a', '2026-06-01')];
    expect(rosterInWindow(rows, d('2026-10-01'), d('2026-11-01'))).toEqual(['a']);
  });
  it('covers dates before its start when openStart (the first observation is a floor)', () => {
    const rows = [{ login: 'a', start: d('2026-10-03'), end: null, openStart: true }];
    expect(rosterInWindow(rows, d('2026-01-01'), d('2026-02-01'))).toEqual(['a']);
  });
});

describe('teamLogins', () => {
  const teams = [{ key: 'platform-team', parent: 'producteng' }, { key: 'producteng', parent: null }, { key: 'factory', parent: 'producteng' }];
  const since = d('2026-10-01'); const until = d('2026-11-01');

  it('takes the team and its descendants', () => {
    const rows = [m('platform-team', 'a', '2026-01-01'), m('factory', 'b', '2026-01-01'), m('other', 'c', '2026-01-01')];
    expect(teamLogins(teams, rows, 'producteng', since, until)).toEqual(['a', 'b']);
    expect(teamLogins(teams, rows, 'platform-team', since, until)).toEqual(['a']);
  });
  it('lets a manual row win over a synced one for the same login', () => {
    const rows = [m('platform-team', 'a', '2026-01-01', '2026-10-05', 'synced'), m('platform-team', 'a', '2026-01-01', null, 'manual')];
    expect(teamLogins(teams, rows, 'platform-team', since, until)).toEqual(['a']);
  });
  it('keeps every interval of a login, not just one (a rejoin)', () => {
    const rows = [m('platform-team', 'a', '2026-01-01', '2026-02-01'), m('platform-team', 'a', '2026-06-01')];
    expect(teamLogins(teams, rows, 'platform-team', since, until)).toEqual(['a']);
    expect(teamLogins(teams, rows, 'platform-team', d('2026-03-01'), d('2026-04-01'))).toEqual([]);
  });
  it('keeps all intervals of the winning (manual) source', () => {
    const rows = [m('platform-team', 'a', '2026-01-01', null, 'synced'), m('platform-team', 'a', '2026-01-01', '2026-02-01', 'manual'), m('platform-team', 'a', '2026-06-01', null, 'manual')];
    expect(teamLogins(teams, rows, 'platform-team', d('2026-07-01'), d('2026-08-01'))).toEqual(['a']);
  });
});

describe('seeds', () => {
  it('ship no teams and no rosters', () => {
    expect(SEED_TEAMS).toEqual([]);
    expect(SEED_TEAM_MEMBERS).toEqual([]);
  });
});
