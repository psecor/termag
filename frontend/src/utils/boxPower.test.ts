import { describe, expect, it } from 'vitest';
import type { InstanceStatus } from '../types';
import {
  boxDisplay,
  canHibernateBox,
  canStartBox,
  canStopBox,
  hibernatedDays,
  hibernationAgeNote,
  isBoxParked,
  showsBoxError,
} from './boxPower';

const statuses: InstanceStatus[] = [
  'provisioning', 'awaiting-agent', 'ready', 'stopping', 'stopped', 'starting', 'hibernating', 'hibernated',
  'failed', 'terminated',
];
const ec2 = (status: InstanceStatus) => ({ kind: 'ec2' as const, status, ec2InstanceId: 'i-0abc' });

describe('box power actions', () => {
  it('offers Stop box on ready and starting EC2 boxes only', () => {
    expect(statuses.filter(s => canStopBox(ec2(s)))).toEqual(['ready', 'starting']);
  });

  it('offers Start box on stopped and hibernated EC2 boxes only', () => {
    expect(statuses.filter(s => canStartBox(ec2(s)))).toEqual(['stopped', 'hibernated']);
  });

  it('offers Hibernate box only on a ready box launched hibernation-capable', () => {
    expect(statuses.filter(s => canHibernateBox({ ...ec2(s), hibernationConfigured: true }))).toEqual(['ready']);
    expect(canHibernateBox({ ...ec2('ready'), hibernationConfigured: false })).toBe(false);
    expect(canHibernateBox(ec2('ready'))).toBe(false);
  });

  it('offers none on a self-managed box or one with no instance yet', () => {
    expect(canStopBox({ kind: 'external', status: 'ready', ec2InstanceId: null })).toBe(false);
    expect(canStopBox({ kind: 'ec2', status: 'ready', ec2InstanceId: null })).toBe(false);
    expect(canStartBox({ kind: 'ec2', status: 'stopped', ec2InstanceId: null })).toBe(false);
    expect(canHibernateBox({ kind: 'ec2', status: 'ready', ec2InstanceId: null, hibernationConfigured: true })).toBe(false);
  });
});

describe('boxDisplay', () => {
  // A stopped box is parked on purpose, so it must not read as broken.
  it('shows a stopped box as a neutral, labelled state rather than the failure red', () => {
    expect(boxDisplay('stopped')).toEqual({ dot: 'var(--text-secondary)', spinning: false, label: 'stopped' });
    expect(boxDisplay('stopped').dot).not.toBe(boxDisplay('failed').dot);
    expect(boxDisplay('hibernated')).toEqual({ dot: 'var(--text-secondary)', spinning: false, label: 'hibernated' });
  });

  it('spins while stopping, hibernating or starting', () => {
    expect(boxDisplay('stopping')).toMatchObject({ spinning: true, label: 'stopping…' });
    expect(boxDisplay('starting')).toMatchObject({ spinning: true, label: 'starting…' });
    expect(boxDisplay('hibernating')).toMatchObject({ spinning: true, label: 'hibernating…' });
  });

  it('shows the project count for a ready box', () => {
    expect(boxDisplay('ready').label).toBe(null);
  });
});

describe('showsBoxError', () => {
  it('shows a power error on ready, stopped, starting and hibernated boxes only', () => {
    expect(statuses.filter(s => showsBoxError({ status: s, provisioningError: 'x' })))
      .toEqual(['ready', 'stopped', 'starting', 'hibernated']);
    expect(showsBoxError({ status: 'starting', provisioningError: null })).toBe(false);
  });
});

describe('isBoxParked', () => {
  it('is true only while a box is down or on its way up or down', () => {
    expect(statuses.filter(isBoxParked)).toEqual(['stopping', 'stopped', 'starting', 'hibernating', 'hibernated']);
    expect(isBoxParked(undefined)).toBe(false);
  });
});

describe('hibernation age', () => {
  const day = 24 * 60 * 60 * 1000;
  const now = Date.UTC(2026, 9, 6, 12);
  const box = (daysAgo: number, status: InstanceStatus = 'hibernated') =>
    ({ status, hibernatedAt: new Date(now - daysAgo * day).toISOString() });

  it('counts whole days, and only for a hibernated box', () => {
    expect(hibernatedDays(box(3.5), now)).toBe(3);
    expect(hibernatedDays(box(3, 'starting'), now)).toBe(null);
    expect(hibernatedDays({ status: 'hibernated', hibernatedAt: null }, now)).toBe(null);
  });

  it('warns from day 50 about the 60-day limit', () => {
    expect(hibernationAgeNote(box(49), now)).toBe(null);
    expect(hibernationAgeNote(box(52), now)).toMatch(/Hibernated 52 days\. EC2 allows 60/);
  });
});
