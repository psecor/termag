// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { clampPage, compareValues, loadPageSize, matchesTerms, nodeText, pageCount, pageSlice, queryTerms, rangeText, savePageSize, sortRows } from './tablePaging';

describe('compareValues and sortRows', () => {
  it('sorts versions by their parts as numbers: 2.1.318 above 2.1.99', () => {
    const versions = ['2.1.99', '2.1.318', '2.1.3', '0.165.0', '0.99.1', '10.0.0'];
    expect(sortRows(versions, v => v, false)).toEqual(['0.99.1', '0.165.0', '2.1.3', '2.1.99', '2.1.318', '10.0.0']);
    expect(sortRows(versions, v => v, true)[0]).toBe('10.0.0');
    expect(compareValues('2.1.318', '2.1.99')).toBeGreaterThan(0);
  });
  it('sorts numbers (dates as Date.parse, sizes in bytes) as numbers, and names naturally, case ignored', () => {
    expect(sortRows([1e9, 2e6, 3e10], v => v, false)).toEqual([2e6, 1e9, 3e10]);
    const days = ['2026-11-04T10:00:00Z', '2026-10-30T09:00:00Z', '2026-11-01T00:00:00Z'];
    expect(sortRows(days, d => Date.parse(d), true)).toEqual([days[0], days[2], days[1]]);
    expect(sortRows(['box-10', 'Box-9', 'box-1'], v => v, false)).toEqual(['box-1', 'Box-9', 'box-10']);
  });
  it('keeps empty values last in either direction, and equal rows in their order', () => {
    const rows = [{ k: 'a', v: null }, { k: 'b', v: 2 }, { k: 'c', v: '' }, { k: 'd', v: 1 }, { k: 'e', v: 2 }];
    expect(sortRows(rows, r => r.v, false).map(r => r.k)).toEqual(['d', 'b', 'e', 'a', 'c']);
    expect(sortRows(rows, r => r.v, true).map(r => r.k)).toEqual(['b', 'e', 'd', 'a', 'c']);
  });
});

describe('the text filter', () => {
  it('reads the text of elements and of a wrapper\'s children, not what a component draws from its props', () => {
    const Comp = () => React.createElement('b', null, 'hidden');
    const Wrapper = ({ children }: { children?: React.ReactNode }) => React.createElement('a', null, children);
    const node = React.createElement(React.Fragment, null, React.createElement('button', null, 'otter-box'), ' · ', React.createElement('span', null, 'offline', 3), React.createElement(Comp),
      React.createElement(Wrapper, null, '2 running'));
    expect(nodeText(node)).toBe('otter-box  ·  offline 3  2 running');
  });
  it('matches every word, case ignored', () => {
    expect(queryTerms('  Otter  2.1 ')).toEqual(['otter', '2.1']);
    expect(matchesTerms('otter-box river 2.1.312', queryTerms('Otter 2.1'))).toBe(true);
    expect(matchesTerms('otter-box river 2.1.312', queryTerms('otter marsh'))).toBe(false);
    expect(matchesTerms('anything', queryTerms(''))).toBe(true);
  });
});

describe('paging', () => {
  const rows = Array.from({ length: 279 }, (_, i) => i + 1);
  it('cuts pages of 25, 50 and 100, and shows every row at All', () => {
    expect(pageSlice(rows, 0, 25)).toMatchObject({ from: 1, to: 25, page: 0, pages: 12 });
    expect(pageSlice(rows, 11, 25)).toMatchObject({ from: 276, to: 279, page: 11 });
    expect(pageSlice(rows, 11, 25).rows).toEqual([276, 277, 278, 279]);
    expect(pageSlice(rows, 1, 100)).toMatchObject({ from: 101, to: 200, pages: 3 });
    expect(pageSlice(rows, 0, 50).pages).toBe(6);
    expect(pageSlice(rows, 3, 'all')).toMatchObject({ from: 1, to: 279, page: 0, pages: 1 });
    expect(pageSlice(rows, 3, 'all').rows).toHaveLength(279);
  });
  it('holds a page past the end to the last page, and an empty table on page 1 of 1', () => {
    expect(clampPage(20, 279, 25)).toBe(11);
    expect(clampPage(-1, 279, 25)).toBe(0);
    expect(pageCount(0, 25)).toBe(1);
    expect(pageSlice([], 4, 25)).toMatchObject({ from: 0, to: 0, page: 0, pages: 1 });
  });
  it('says the range, and what a filter left out', () => {
    expect(rangeText(1, 25, 279, 279)).toBe('1–25 of 279');
    expect(rangeText(26, 40, 40, 279)).toBe('26–40 of 40, filtered from 279');
    expect(rangeText(0, 0, 0, 279)).toBe('0 of 0, filtered from 279');
  });
});

describe('the remembered page size', () => {
  afterEach(() => window.localStorage.clear());
  it('is 25 until the viewer picks one, and only a size the table offers', () => {
    expect(loadPageSize('fleet')).toBe(25);
    savePageSize('fleet', 100);
    expect(loadPageSize('fleet')).toBe(100);
    savePageSize('fleet', 'all');
    expect(loadPageSize('fleet')).toBe('all');
    expect(loadPageSize('users')).toBe(25);
    expect(loadPageSize(undefined)).toBe(25);
    window.localStorage.setItem('termag.admin.pageSize.fleet', '7');
    expect(loadPageSize('fleet')).toBe(25);
  });
});
