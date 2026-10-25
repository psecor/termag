// Review groups on the phone: the card
// at the top of the PR screen's My review lane, folded to one line
// ("Desktop bridge · 4 of 5 to review") and opening to the ordered list, and
// the Add to group sheet a row's ⋯ offers. Editing a group (reorder, notes,
// rename, delete) stays on the web; the phone adds, moves and takes out.
import React, { useState } from 'react';
import { prsApi, type PrGroupMember, type PrGroupSuggestion, type PrReviewGroup, type PrRow } from '../../services/api';
import {
  acceptSuggestion, groupKey, groupProgress, groupReviewPlan, groupSize, memberInputs, memberLabel, memberStatus, nextMember, suggestionWhy,
} from '../../utils/prReviewGroups';
import { Sheet, apiError } from './Sheet';

export function MobileGroupCard({ group, viewer, now, onOpen, onMenu, onBareMenu, onReviewAll }: {
  group: PrReviewGroup;
  viewer: string | null;
  now: number;
  /** A member tapped: its overview when it has a row, else GitHub. */
  onOpen: (m: PrGroupMember) => void;
  /** A member's ⋯: the row's action sheet (Add to group's move and take out among it), as a row's ⋯ (Bugbot, #668). */
  onMenu: (row: PrRow) => void;
  /** A member GitHub could not read has no row: its ⋯ still opens it there or takes it out (Devin, #668). */
  onBareMenu: (group: PrReviewGroup, m: PrGroupMember) => void;
  onReviewAll: (group: PrReviewGroup) => void;
}) {
  const [open, setOpen] = useState(false);
  const next = nextMember(group, viewer);
  const plan = groupReviewPlan(group, viewer);
  return (
    <li className="m-row-wrap m-prg" data-done={group.done || undefined}>
      <button className="m-row m-pr-row m-prg-head" aria-expanded={open} onClick={() => setOpen(o => !o)}>
        <span className="m-glyph m-pr-glyph" aria-hidden>{group.done ? '✓' : open ? '▾' : '▸'}</span>
        <span className="m-row-main">
          <span className="m-row-title">{group.name}</span>
          <span className="m-row-preview">{groupSize(group)} · {groupProgress(group, viewer)}</span>
        </span>
      </button>
      {open && (
        <div className="m-prg-body">
          <ol className="m-prg-members">
            {group.members.map((m, i) => (
              <li key={`${m.repo}#${m.number}`} className="m-prg-member-wrap">
                <button className="m-prg-member" data-checked={m.checked || undefined} data-next={m === next || undefined} onClick={() => onOpen(m)}>
                  <span className="m-prg-mark" aria-label={m.checked ? 'checked off' : m === next ? 'next' : undefined}>{m.checked ? '✓' : m === next ? '→' : i + 1}</span>
                  <span className="m-row-main">
                    <span className="m-row-title">{m.title || memberLabel(m)}</span>
                    <span className="m-row-preview">{memberLabel(m)} · {memberStatus(m, viewer, now)}{m.note ? ` · ${m.note}` : ''}</span>
                  </span>
                </button>
                <button className="m-more" aria-label={`Actions for ${memberLabel(m)}`} onClick={() => (m.row ? onMenu(m.row) : onBareMenu(group, m))}>⋯</button>
              </li>
            ))}
          </ol>
          <div className="m-prg-actions">
            {next && <button className="m-sheet-action" onClick={() => onOpen(next)}>Review next · {memberLabel(next)}</button>}
            {!group.done && (
              <button className="m-sheet-action" disabled={'reason' in plan} onClick={() => onReviewAll(group)}>
                {'reason' in plan ? plan.reason : `Review all with Devin (${plan.members.length})…`}
              </button>
            )}
          </div>
        </div>
      )}
    </li>
  );
}

/**
 * The Add to group sheet: put the row's PR at the end of one of the open
 * groups, move it to another, take it out, or start a new group with it.
 */
export function AddToGroupSheet({ row, groups, onClose, onChanged, onError }: {
  row: PrRow;
  groups: PrReviewGroup[];
  onClose: () => void;
  onChanged: () => void;
  onError: (msg: string) => void;
}) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const key = groupKey(row);
  if (!key || !row.repo || row.number == null) return null;
  const pr = { repo: row.repo, number: row.number, note: null };
  const isKey = (m: PrGroupMember) => groupKey({ kind: 'pr', ...m }) === key;
  const current = groups.find(g => g.members.some(isKey)) ?? null;

  const run = async (fn: () => Promise<unknown>, failure: string) => {
    setBusy(true);
    try { await fn(); onChanged(); onClose(); } catch (err) { onError(apiError(err, failure)); onClose(); } finally { setBusy(false); }
  };
  const create = (e?: React.FormEvent) => {
    e?.preventDefault();
    const n = name.trim();
    if (n) void run(() => prsApi.createGroup(n, [pr]), 'Could not make the group');
  };
  return (
    <Sheet title={`Review group · ${row.repo.split('/')[1] ?? row.repo}#${row.number}`} onClose={onClose}>
      <div className="m-sheet-actions">
        {groups.map(g => (g === current
          ? <button key={g.id} className="m-sheet-action danger" disabled={busy}
            onClick={() => { void run(() => prsApi.setGroupMembers(g.id, memberInputs(g.members.filter(m => !isKey(m)))), 'Could not take it out of the group'); }}>
            Take it out of {g.name}
          </button>
          : <button key={g.id} className="m-sheet-action" disabled={busy}
            onClick={() => { void run(() => prsApi.setGroupMembers(g.id, [...memberInputs(g.members), pr]), 'Could not add it to the group'); }}>
            {current ? 'Move to' : 'Add to'} {g.name} ({g.members.length})
          </button>))}
        <form className="m-form m-prg-new" onSubmit={create}>
          <input className="m-input" aria-label="New group name" placeholder="New group name" maxLength={80} value={name} disabled={busy}
            onChange={e => setName(e.target.value)} />
          <button type="submit" className="m-sheet-action" disabled={busy || !name.trim()}>New group</button>
        </form>
        <button className="m-sheet-action m-sheet-cancel" onClick={onClose}>Cancel</button>
      </div>
    </Sheet>
  );
}

/** A suggested review group's row above the cards: tapped, its sheet. */
export function MobileSuggestionRow({ suggestion, onOpen }: { suggestion: PrGroupSuggestion; onOpen: (s: PrGroupSuggestion) => void }) {
  return (
    <li className="m-row-wrap m-prg m-prg-suggestion">
      <button className="m-row m-pr-row m-prg-head" onClick={() => onOpen(suggestion)}>
        <span className="m-glyph m-pr-glyph" aria-hidden>◇</span>
        <span className="m-row-main">
          <span className="m-row-title">Suggested{suggestion.target ? ` for ${suggestion.target.name}` : ' group'}</span>
          <span className="m-row-preview">{suggestionWhy(suggestion)} · {suggestion.members.map(memberLabel).join(', ')}</span>
        </span>
      </button>
    </li>
  );
}

/**
 * A suggestion's sheet: its PRs in order, then Make the group (a name to
 * start from) or Add to <group>, and Not these. Nothing is grouped without one.
 */
export function SuggestionSheet({ suggestion, groups, onClose, onChanged, onError }: {
  suggestion: PrGroupSuggestion;
  groups: PrReviewGroup[];
  onClose: () => void;
  onChanged: () => void;
  onError: (msg: string) => void;
}) {
  const [name, setName] = useState(suggestion.name);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>, failure: string) => {
    setBusy(true);
    try { await fn(); onChanged(); onClose(); } catch (err) { onError(apiError(err, failure)); onClose(); } finally { setBusy(false); }
  };
  const accept = (e?: React.FormEvent) => {
    e?.preventDefault();
    const plan = acceptSuggestion(suggestion, groups);
    if ('gone' in plan) { onError('That group is gone: pull to refresh'); onClose(); return; }
    if ('set' in plan) void run(() => prsApi.setGroupMembers(plan.set.id, plan.set.members), 'Could not add them to the group');
    else if (name.trim()) void run(() => prsApi.createGroup(name.trim(), plan.create.members), 'Could not make the group');
  };
  return (
    <Sheet title={`Suggested · ${suggestionWhy(suggestion)}`} onClose={onClose}>
      <ol className="m-sheet-steps">
        {suggestion.members.map(m => <li key={`${m.repo}#${m.number}`}>{memberLabel(m)} · {m.title}</li>)}
      </ol>
      <div className="m-sheet-actions">
        {suggestion.target ? (
          <button className="m-sheet-action" disabled={busy} onClick={() => accept()}>Add {suggestion.members.length} to {suggestion.target.name}</button>
        ) : (
          <form className="m-form m-prg-new" onSubmit={accept}>
            <input className="m-input" aria-label="Group name" maxLength={80} value={name} disabled={busy} onChange={e => setName(e.target.value)} />
            <button type="submit" className="m-sheet-action" disabled={busy || !name.trim()}>Make the group</button>
          </form>
        )}
        <button className="m-sheet-action" disabled={busy}
          onClick={() => { void run(() => prsApi.dismissSuggestion(suggestion.key), 'Could not dismiss it'); }}>Not these</button>
        <button className="m-sheet-action m-sheet-cancel" onClick={onClose}>Cancel</button>
      </div>
    </Sheet>
  );
}
