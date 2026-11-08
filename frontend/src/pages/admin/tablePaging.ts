// The admin tables' sorting, text filter and paging (DataTable in DataTable.tsx),
// as pure functions so they can be tested without rendering.
import React from 'react';

export type SortValue = string | number | null | undefined;

/** The page sizes a table offers; 'all' shows every row. */
export const PAGE_SIZES = [25, 50, 100, 'all'] as const;
export type PageSize = typeof PAGE_SIZES[number];
export const DEFAULT_PAGE_SIZE: PageSize = 25;
/** A table with this many rows or fewer has nothing to page, so it shows no pager. */
export const PAGER_MIN_ROWS = PAGE_SIZES[0];

// Numeric collation: "2.1.318" after "2.1.99", "box-10" after "box-9", case ignored.
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/**
 * Ascending order of two sort values. Numbers compare as numbers; strings in natural order, so a
 * version's parts compare as numbers. Empty values (null, undefined, '') are not compared here:
 * sortRows keeps them last in either direction.
 */
export function compareValues(a: SortValue, b: SortValue): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return collator.compare(String(a), String(b));
}

const isEmpty = (v: SortValue) => v == null || v === '' || (typeof v === 'number' && Number.isNaN(v));

/** The rows sorted by `value`, empty values last whichever the direction; equal rows keep their order. */
export function sortRows<T>(rows: readonly T[], value: (row: T) => SortValue, desc: boolean): T[] {
  return [...rows].sort((x, y) => {
    const a = value(x), b = value(y);
    const ea = isEmpty(a), eb = isEmpty(b);
    if (ea || eb) return ea === eb ? 0 : ea ? 1 : -1;
    const c = compareValues(a, b);
    return desc ? -c : c;
  });
}

/**
 * The text a rendered cell shows: strings and numbers, and the children of any element (an HTML
 * element, a fragment, or a wrapper such as a router Link). What a component draws from its other
 * props can't be read without rendering it, so a column whose cell is such a component says what it
 * shows with `text` (Column in DataTable.tsx).
 */
export function nodeText(node: React.ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join(' ');
  if (React.isValidElement(node)) return nodeText((node.props as { children?: React.ReactNode }).children);
  return '';
}

/** Lower-cased words of a filter query; a row matches when its text holds every one. */
export const queryTerms = (query: string): string[] => query.toLowerCase().split(/\s+/).filter(Boolean);
export const matchesTerms = (text: string, terms: readonly string[]): boolean => {
  const t = text.toLowerCase();
  return terms.every(w => t.includes(w));
};

/** How many pages `total` rows make at `size`: at least one, so an empty table is on page 1 of 1. */
export const pageCount = (total: number, size: PageSize): number => (size === 'all' ? 1 : Math.max(1, Math.ceil(total / size)));

/**
 * The page actually shown: `page` held within the pages there are. The stored page is left as it
 * is, so a refresh that briefly returns fewer rows doesn't move the reader once the rows are back.
 */
export const clampPage = (page: number, total: number, size: PageSize): number => Math.min(Math.max(0, page), pageCount(total, size) - 1);

/** The rows of a page, and the 1-based range it covers ("1–25 of 279"). */
export function pageSlice<T>(rows: readonly T[], page: number, size: PageSize): { rows: T[]; from: number; to: number; page: number; pages: number } {
  const pages = pageCount(rows.length, size);
  const p = clampPage(page, rows.length, size);
  if (size === 'all') return { rows: [...rows], from: rows.length ? 1 : 0, to: rows.length, page: 0, pages };
  const start = p * size;
  const shown = rows.slice(start, start + size);
  return { rows: shown, from: shown.length ? start + 1 : 0, to: start + shown.length, page: p, pages };
}

/** "1–25 of 279", and "of 40, filtered from 279" while a filter hides rows. */
export function rangeText(from: number, to: number, total: number, unfiltered: number): string {
  const of = total === unfiltered ? `${total}` : `${total}, filtered from ${unfiltered}`;
  return total === 0 ? `0 of ${of}` : `${from}–${to} of ${of}`;
}

const STORAGE_PREFIX = 'termag.admin.pageSize.';
const parsePageSize = (s: string | null): PageSize | null => {
  if (s === 'all') return 'all';
  const n = Number(s);
  return (PAGE_SIZES as readonly PageSize[]).includes(n as PageSize) ? (n as PageSize) : null;
};

/** The page size this viewer last chose for the table, else the default. Storage may be off or full. */
export function loadPageSize(key: string | undefined): PageSize {
  if (!key) return DEFAULT_PAGE_SIZE;
  try { return parsePageSize(window.localStorage.getItem(STORAGE_PREFIX + key)) ?? DEFAULT_PAGE_SIZE; } catch { return DEFAULT_PAGE_SIZE; }
}
export function savePageSize(key: string | undefined, size: PageSize): void {
  if (!key) return;
  try { window.localStorage.setItem(STORAGE_PREFIX + key, String(size)); } catch { /* private mode or full: the choice lasts for this page */ }
}
