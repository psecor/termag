// The admin pages' table: sorts by any column (the whole set, then pages), filters on the text its
// columns show, and pages at 25, 50, 100 or all rows. Its controls are LaunchPad's (docs/agents/gotchas.md,
// "New simple-UI controls are LaunchPad's"); the pure parts are in tablePaging.ts.
import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Group, IconButton, Input, ListBox, ListBoxItem, Popover, SearchField, Select, SelectValue } from '@launchpad-ui/components';
import { Icon } from '@launchpad-ui/icons';
import { LP_THEME } from '../../launchpad/theme';
import { ensureLaunchPadSprite } from '../../launchpad/sprite';
import {
  PAGE_SIZES, PAGER_MIN_ROWS, loadPageSize, matchesTerms, nodeText, pageSlice, queryTerms, rangeText, savePageSize, sortRows,
  type PageSize, type SortValue,
} from './tablePaging';

const TableResetContext = createContext<unknown>(null);

/**
 * A page's or a shell's own filters (a range, a window, a provider) for every DataTable inside it:
 * when `value` changes they go back to page 1, as a table's own `resetKey` does. Nested ones add to
 * their parent's. A poll refresh changes neither, so it keeps the reader's page.
 */
export function TableReset({ value, children }: { value: unknown; children: React.ReactNode }) {
  const parent = useContext(TableResetContext);
  const combined = useMemo(() => [parent, value], [parent, JSON.stringify(value)]);
  return <TableResetContext.Provider value={combined}>{children}</TableResetContext.Provider>;
}

/** A column: how to pull its sort value, and how to render it. */
export interface Column<T> {
  id: string; label: string;
  /** What the column sorts by: a number (dates as Date.parse, sizes in bytes) or a string, compared in natural order. */
  value: (row: T) => SortValue;
  render?: (row: T) => React.ReactNode;
  align?: 'left' | 'right';
  title?: string;
  /**
   * What the text filter matches in this column. By default the string value and the text of the
   * rendered cell; give it when the cell is a component (whose text the table can't read), or to
   * leave the column out of the filter (return '').
   */
  text?: (row: T) => string;
}

const cellText = <T,>(c: Column<T>, row: T): string => {
  if (c.text) return c.text(row);
  const v = c.value(row);
  const shown = c.render ? nodeText(c.render(row)) : v == null ? '' : String(v);
  return typeof v === 'string' && !shown.includes(v) ? `${v} ${shown}` : shown;
};

export interface DataTableProps<T> {
  rows: T[]; columns: Column<T>[]; rowKey: (row: T) => string;
  /** The column it opens sorted by; none keeps the rows in the order given until a header is clicked. */
  defaultSort?: string; defaultDesc?: boolean; empty?: string; dense?: boolean; className?: string;
  /** Rows become selectable (click, Enter or Space); the one whose key is `selectedKey` is marked. */
  onRowClick?: (row: T) => void; selectedKey?: string | null;
  /** Show a text filter over the visible columns once there are more than 25 rows; a string is its placeholder. */
  search?: boolean | string;
  /** Remembers the viewer's page size for this table (localStorage), under this name. */
  storageKey?: string;
  /**
   * The page's own filters (a checkbox, a select): when this changes the table goes back to page 1,
   * as it does when a TableReset around it changes. A poll refresh changes `rows` but neither of
   * these, so it keeps the page, the sort and the filter.
   */
  resetKey?: unknown;
  /** false for a table whose rows already come a page at a time from the server (Signals' Load more): every loaded row shows, with no pager. */
  paginate?: boolean;
}

export function DataTable<T>({ rows, columns, rowKey, defaultSort, defaultDesc = true, empty = 'nothing to show', dense, className, onRowClick, selectedKey, search, storageKey, resetKey, paginate = true }: DataTableProps<T>) {
  const [sort, setSort] = useState<string | null>(defaultSort ?? null);
  const [desc, setDesc] = useState(defaultDesc);
  const [query, setQuery] = useState('');
  const [chosenSize, setSizeState] = useState<PageSize>(() => loadPageSize(storageKey));
  const size: PageSize = paginate ? chosenSize : 'all';
  const [page, setPage] = useState(0);
  // The page's filters changed (its resetKey, or a TableReset around it): back to page 1, in the same
  // render (no flash of an empty page).
  const outer = useContext(TableResetContext);
  const resetSig = JSON.stringify([outer, resetKey ?? null]);
  const [lastReset, setLastReset] = useState(resetSig);
  if (lastReset !== resetSig) { setLastReset(resetSig); setPage(0); }

  const terms = useMemo(() => queryTerms(query), [query]);
  const filtered = useMemo(
    () => (terms.length ? rows.filter(r => matchesTerms(columns.map(c => cellText(c, r)).join(' '), terms)) : rows),
    [rows, columns, terms],
  );
  const sorted = useMemo(() => {
    const col = sort == null ? null : columns.find(c => c.id === sort) ?? null;
    return col ? sortRows(filtered, col.value, desc) : filtered;
  }, [filtered, columns, sort, desc]);
  const shown = pageSlice(sorted, page, size);
  const paged = paginate && sorted.length > PAGER_MIN_ROWS;

  // A row selected from outside (a link to ?box=…) opens on its page, once its row has loaded.
  const reveal = useRef<string | null>(selectedKey ?? null);
  const lastSelected = useRef(selectedKey ?? null);
  if (lastSelected.current !== (selectedKey ?? null)) { lastSelected.current = selectedKey ?? null; reveal.current = selectedKey ?? null; }
  useEffect(() => {
    if (!reveal.current || size === 'all') return;
    const at = sorted.findIndex(r => rowKey(r) === reveal.current);
    if (at < 0) return;
    reveal.current = null;
    const p = Math.floor(at / size);
    if (p !== shown.page) setPage(p);
  });

  const click = (id: string) => {
    if (id === sort) setDesc(d => !d); else { setSort(id); setDesc(true); }
    setPage(0);
  };
  const setSize = (s: PageSize) => { setSizeState(s); savePageSize(storageKey, s); setPage(0); };
  const onQuery = (q: string) => { setQuery(q); setPage(0); };
  const marked = onRowClick || selectedKey !== undefined;

  return (
    <div className="admin-data-table">
      {/* A table short enough to read whole has no filter; one being typed in stays while a refresh shrinks it. */}
      {search && (rows.length > PAGER_MIN_ROWS || query) && <TableSearch value={query} onChange={onQuery} placeholder={typeof search === 'string' ? search : 'filter rows'} />}
      <div className="admin-table-wrap">
        <table className={`admin-table ${dense ? 'admin-table--dense' : ''} ${className ?? ''}`}>
          <thead>
            <tr>{columns.map(c => (
              <th key={c.id} className={c.align ?? 'left'} title={c.title} onClick={() => click(c.id)} aria-sort={sort === c.id ? (desc ? 'descending' : 'ascending') : 'none'}>
                {c.label}{sort === c.id ? (desc ? ' ▾' : ' ▴') : ''}
              </th>
            ))}</tr>
          </thead>
          <tbody>
            {sorted.length === 0 && <tr><td colSpan={columns.length} className="usage-dim">{rows.length && terms.length ? `nothing matches “${query.trim()}”` : empty}</td></tr>}
            {shown.rows.map(r => {
              const key = rowKey(r);
              const selected = marked && key === selectedKey;
              const select = onRowClick ? {
                tabIndex: 0, 'aria-selected': selected,
                onClick: () => onRowClick(r),
                onKeyDown: (e: React.KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onRowClick(r); } },
              } : {};
              const cls = [onRowClick ? 'admin-row--selectable' : '', selected ? 'admin-row--selected' : ''].filter(Boolean).join(' ');
              return <tr key={key} className={cls || undefined} {...select}>{columns.map(c => <td key={c.id} className={c.align ?? 'left'}>{c.render ? c.render(r) : (c.value(r) ?? '—')}</td>)}</tr>;
            })}
          </tbody>
        </table>
      </div>
      {paged && <TablePager page={shown.page} pages={shown.pages} from={shown.from} to={shown.to} total={sorted.length} unfiltered={rows.length} size={size} onPage={setPage} onSize={setSize} />}
    </div>
  );
}

function TableSearch({ value, onChange, placeholder }: { value: string; onChange: (q: string) => void; placeholder: string }) {
  useEffect(() => { void ensureLaunchPadSprite(); }, []);
  return (
    <div className="admin-table-tools">
      <SearchField aria-label={placeholder} value={value} onChange={onChange} className={`${LP_THEME} admin-table-search`}>
        <Group>
          <Icon name="search" size="medium" aria-hidden="true" />
          <Input placeholder={placeholder} />
          {value && <IconButton icon="cancel" aria-label="clear the filter" size="small" variant="minimal" onPress={() => onChange('')} />}
        </Group>
      </SearchField>
    </div>
  );
}

/** "1–25 of 279", the page size (25, 50, 100, All) and first / previous / next / last. */
export function TablePager({ page, pages, from, to, total, unfiltered, size, onPage, onSize }: {
  page: number; pages: number; from: number; to: number; total: number; unfiltered: number; size: PageSize;
  onPage: (p: number) => void; onSize: (s: PageSize) => void;
}) {
  useEffect(() => { void ensureLaunchPadSprite(); }, []);
  const first = page <= 0, last = page >= pages - 1;
  return (
    <div className={`${LP_THEME} admin-pager`} role="navigation" aria-label="table pages">
      <span className="admin-pager-range" aria-live="polite">{rangeText(from, to, total, unfiltered)}</span>
      <Select aria-label="rows per page" selectedKey={String(size)} className="admin-pager-size"
        onSelectionChange={k => onSize(k === 'all' ? 'all' : (Number(k) as PageSize))}>
        <Button size="small"><SelectValue /><Icon name="chevron-down" size="medium" aria-hidden="true" /></Button>
        <Popover className={LP_THEME}>
          <ListBox>
            {PAGE_SIZES.map(s => <ListBoxItem key={s} id={String(s)} textValue={s === 'all' ? 'All' : `${s} per page`}>{s === 'all' ? 'All' : `${s} per page`}</ListBoxItem>)}
          </ListBox>
        </Popover>
      </Select>
      {size !== 'all' && (
        <span className="admin-pager-nav">
          <IconButton icon="chevrons-left" aria-label="first page" size="small" variant="minimal" isDisabled={first} onPress={() => onPage(0)} />
          <IconButton icon="chevron-left" aria-label="previous page" size="small" variant="minimal" isDisabled={first} onPress={() => onPage(page - 1)} />
          <span className="admin-pager-page">page {page + 1} of {pages}</span>
          <IconButton icon="chevron-right" aria-label="next page" size="small" variant="minimal" isDisabled={last} onPress={() => onPage(page + 1)} />
          <IconButton icon="chevrons-right" aria-label="last page" size="small" variant="minimal" isDisabled={last} onPress={() => onPage(pages - 1)} />
        </span>
      )}
    </div>
  );
}
