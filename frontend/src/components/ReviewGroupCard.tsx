import { useEffect, useState } from 'react';
import { prsApi, type PrGroupMember, type PrGroupSuggestion, type PrReviewGroup, type PrRow } from '../services/api';
import { apiErrorText, rowParam } from '../utils/prPipeline';
import { fmtAge } from '../utils/format';
import {
  acceptSuggestion, groupKey, groupProgress, groupReviewPlan, groupSize, memberInputs, memberLabel, memberStatus, moved, nextMember, parseGroupPr, suggestionWhy,
} from '../utils/prReviewGroups';

/**
 * A review group's card at the top of the PR overlay's Needs you and Needs my
 * review: the user's own ordered list
 * of PRs reviewed together. Each member keeps its row, so picking one opens
 * it in the detail pane as any row does; one checked off (your review, or
 * merged or closed) stays, ticked, until the whole group is done. Done, the
 * card folds to one line with Close group.
 *
 * Review all with Devin (onReviewAll; the overlay confirms) starts one Devin
 * session over the members left to review, in order (groupReviewPlan).
 *
 * Edit… renames it, reorders the members (↑/↓ or drag), keeps a one-line note
 * on each, removes one, adds a PR by `owner/name#N`, `name#N` or URL, or
 * deletes the group. Nothing is written until Save.
 */
export function ReviewGroupCard({ group, viewer, now, selectedKey, knownRepos, onPick, onChanged, onError, onReviewAll }: {
  group: PrReviewGroup;
  viewer: string | null;
  now: number;
  selectedKey: string | null;
  knownRepos: string[];
  onPick: (row: PrRow) => void;
  onChanged: () => void;
  onError: (msg: string) => void;
  /** Absent: no Review all with Devin (a caller that cannot start one). */
  onReviewAll?: (group: PrReviewGroup) => void;
}) {
  const [open, setOpen] = useState(!group.done);
  // Folded when it becomes done (its last member checked off), unfolded if a re-request undoes that.
  useEffect(() => { setOpen(!group.done); }, [group.done]);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const next = nextMember(group, viewer);

  const run = async (fn: () => Promise<unknown>, failure: string): Promise<boolean> => {
    setBusy(true);
    onError('');
    try { await fn(); onChanged(); return true; } catch (err) { onError(apiErrorText(err, failure)); return false; } finally { setBusy(false); }
  };
  const pickMember = (m: PrGroupMember) => {
    if (m.row) onPick(m.row);
    else window.open(m.url, '_blank', 'noopener');
  };

  if (editing) {
    return <GroupEditor group={group} knownRepos={knownRepos} busy={busy} onCancel={() => setEditing(false)}
      onSave={async (name, members) => {
        const ok = await run(async () => {
          if (name !== group.name) await prsApi.updateGroup(group.id, { name });
          const before = JSON.stringify(memberInputs(group.members));
          if (JSON.stringify(memberInputs(members)) !== before) await prsApi.setGroupMembers(group.id, memberInputs(members));
        }, 'Could not save the group.');
        if (ok) setEditing(false);
      }}
      onDelete={async () => { if (await run(() => prsApi.deleteGroup(group.id), 'Could not delete the group.')) setEditing(false); }} />;
  }

  return (
    <section className={`prg-card${group.done ? ' is-done' : ''}`} aria-label={`Review group ${group.name}`}>
      <header className="prg-head">
        <button type="button" className="prg-toggle" aria-expanded={open} onClick={() => setOpen(o => !o)}>
          {open ? '▾' : '▸'} {group.done ? '✓ ' : ''}<span className="prg-name">{group.name}</span>
        </button>
        <span className="usage-dim">{groupSize(group)} · {groupProgress(group, viewer)}</span>
        <span className="prg-actions">
          {!group.done && next && (
            <button type="button" className="btn-ghost btn-tiny" disabled={busy} onClick={() => pickMember(next)}
              title={`Open ${memberLabel(next)}, the first one left to review (not checked off, not yours)`}>Review next</button>
          )}
          {!group.done && onReviewAll && (() => {
            const plan = groupReviewPlan(group, viewer);
            return (
              <button type="button" className="btn-ghost btn-tiny prs-review" disabled={busy || 'reason' in plan}
                title={'reason' in plan ? plan.reason : `One Devin review of the ${plan.members.length} left, in order, in ${plan.target.projectName}${plan.target.workstream !== 'main' ? ` · ${plan.target.workstream}` : ''}`}
                onClick={() => onReviewAll(group)}>Review all with Devin</button>
            );
          })()}
          {group.done && (
            <button type="button" className="btn-ghost btn-tiny" disabled={busy}
              onClick={() => { void run(() => prsApi.updateGroup(group.id, { closed: true }), 'Could not close the group.'); }}>Close group</button>
          )}
          <button type="button" className="btn-ghost btn-tiny" disabled={busy} onClick={() => setEditing(true)}>Edit…</button>
        </span>
      </header>
      {open && (
        <ol className="prg-members">
          {group.members.map((m, i) => {
            const key = m.row ? rowParam(m.row) : null;
            const isNext = next !== null && m === next;
            return (
              <li key={`${m.repo}#${m.number}`}>
                <button type="button" role="option" aria-selected={key !== null && key === selectedKey}
                  className={`prg-member${key !== null && key === selectedKey ? ' active' : ''}${m.checked ? ' is-checked' : ''}${isNext ? ' is-next' : ''}`}
                  onClick={() => pickMember(m)}
                  title={m.row ? undefined : 'Not read from GitHub: opens it there'}>
                  <span className="prg-mark" aria-label={m.checked ? 'checked off' : isNext ? 'next' : undefined}>{m.checked ? '✓' : isNext ? '→' : ''}</span>
                  <span className="prg-pos">{i + 1}</span>
                  <span className="prso-label">{memberLabel(m)}</span>
                  <span className="prg-title">{m.title}</span>
                  <span className="prg-status usage-dim">{memberStatus(m, viewer, now)}{m.note ? <> · <em>{m.note}</em></> : null}</span>
                </button>
              </li>
            );
          })}
          {group.members.length === 0 && <li className="usage-dim prg-empty">No pull requests yet: Edit… to add some, or Add to group on a PR.</li>}
        </ol>
      )}
    </section>
  );
}

interface DraftMember { repo: string; number: number; note: string | null; label: string; title: string }

function GroupEditor({ group, knownRepos, busy, onSave, onCancel, onDelete }: {
  group: PrReviewGroup;
  knownRepos: string[];
  busy: boolean;
  onSave: (name: string, members: DraftMember[]) => Promise<void>;
  onCancel: () => void;
  onDelete: () => Promise<void>;
}) {
  const [name, setName] = useState(group.name);
  const [members, setMembers] = useState<DraftMember[]>(group.members.map(m => ({ repo: m.repo, number: m.number, note: m.note, label: memberLabel(m), title: m.title })));
  const [adding, setAdding] = useState('');
  const [addError, setAddError] = useState('');
  const [drag, setDrag] = useState<number | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const add = () => {
    const pr = parseGroupPr(adding, knownRepos);
    if (!pr) { setAddError('Type owner/name#N, name#N or paste the PR\'s URL.'); return; }
    if (members.some(m => groupKey({ kind: 'pr', ...m }) === groupKey({ kind: 'pr', ...pr }))) { setAddError('It is in the group already.'); return; }
    setMembers([...members, { ...pr, note: null, label: memberLabel(pr), title: 'checked against GitHub on Save' }]);
    setAdding('');
    setAddError('');
  };
  const validName = name.trim().length > 0;

  return (
    <section className="prg-card is-editing" aria-label={`Edit review group ${group.name}`}>
      <header className="prg-head">
        <input className="prg-name-input" aria-label="Group name" value={name} maxLength={80} disabled={busy} onChange={e => setName(e.target.value)} />
      </header>
      <ol className="prg-members">
        {members.map((m, i) => (
          <li key={`${m.repo}#${m.number}`} className={`prg-edit-row${drag === i ? ' is-dragging' : ''}`} draggable={!busy}
            onDragStart={() => setDrag(i)} onDragEnd={() => setDrag(null)}
            onDragOver={e => e.preventDefault()}
            onDrop={e => { e.preventDefault(); if (drag !== null) setMembers(moved(members, drag, i)); setDrag(null); }}>
            <span className="prg-grip" aria-hidden>⋮⋮</span>
            <span className="prg-pos">{i + 1}</span>
            <span className="prso-label">{m.label}</span>
            <span className="prg-title">{m.title}</span>
            <input className="prg-note" aria-label={`Note for ${m.label}`} placeholder="note (optional)" maxLength={200} disabled={busy}
              value={m.note ?? ''} onChange={e => setMembers(members.map((x, j) => (j === i ? { ...x, note: e.target.value || null } : x)))} />
            <button type="button" className="btn-ghost btn-tiny" aria-label={`Move ${m.label} up`} disabled={busy || i === 0} onClick={() => setMembers(moved(members, i, i - 1))}>↑</button>
            <button type="button" className="btn-ghost btn-tiny" aria-label={`Move ${m.label} down`} disabled={busy || i === members.length - 1} onClick={() => setMembers(moved(members, i, i + 1))}>↓</button>
            <button type="button" className="btn-ghost btn-tiny" aria-label={`Remove ${m.label}`} disabled={busy} onClick={() => setMembers(members.filter((_, j) => j !== i))}>✕</button>
          </li>
        ))}
      </ol>
      <div className="prg-add">
        <input aria-label="Add a pull request" placeholder="Add a PR: owner/name#N, name#N or URL" value={adding} disabled={busy}
          onChange={e => { setAdding(e.target.value); setAddError(''); }}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} />
        <button type="button" className="btn-ghost btn-tiny" disabled={busy || !adding.trim()} onClick={add}>Add</button>
      </div>
      {addError && <div className="error-text prg-scope">{addError}</div>}
      <div className="prg-edit-actions">
        <button type="button" className="btn-primary btn-tiny" disabled={busy || !validName} onClick={() => { void onSave(name.trim(), members); }}>{busy ? 'Saving…' : 'Save'}</button>
        <button type="button" className="btn-ghost btn-tiny" disabled={busy} onClick={onCancel}>Cancel</button>
        <span className="prg-delete">
          {confirmDelete ? (
            <>
              <span className="usage-dim">Delete {group.name}? Its PRs stay as they are.</span>
              <button type="button" className="btn-ghost btn-tiny prg-danger" disabled={busy} onClick={() => { void onDelete(); }}>Delete</button>
              <button type="button" className="btn-ghost btn-tiny" disabled={busy} onClick={() => setConfirmDelete(false)}>Keep it</button>
            </>
          ) : (
            <button type="button" className="btn-ghost btn-tiny" disabled={busy} onClick={() => setConfirmDelete(true)}>Delete group…</button>
          )}
        </span>
      </div>
    </section>
  );
}

/**
 * Add to group… in the overlay's detail header: put the shown PR in one of
 * the user's open groups (at the end), move it to another, take it out, or
 * start a new group with it. A PR is in at most one open group.
 */
export function AddToGroup({ row, groups, onChanged, onError }: {
  row: PrRow;
  groups: PrReviewGroup[];
  onChanged: () => void;
  onError: (msg: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const key = groupKey(row);
  if (!key || !row.repo || row.number == null) return null;
  const pr = { repo: row.repo, number: row.number };
  const current = groups.find(g => g.members.some(m => groupKey({ kind: 'pr', ...m }) === key)) ?? null;
  const at = current ? current.members.findIndex(m => groupKey({ kind: 'pr', ...m }) === key) + 1 : 0;

  const run = async (fn: () => Promise<unknown>, failure: string) => {
    setBusy(true);
    onError('');
    try { await fn(); setOpen(false); setName(''); onChanged(); } catch (err) { onError(apiErrorText(err, failure)); } finally { setBusy(false); }
  };
  const addTo = (g: PrReviewGroup) => run(() => prsApi.setGroupMembers(g.id, [...memberInputs(g.members), { ...pr, note: null }]), 'Could not add it to the group.');
  const removeFrom = (g: PrReviewGroup) => run(
    () => prsApi.setGroupMembers(g.id, memberInputs(g.members.filter(m => groupKey({ kind: 'pr', ...m }) !== key))), 'Could not take it out of the group.');
  const create = () => {
    const n = name.trim();
    if (n) void run(() => prsApi.createGroup(n, [{ ...pr, note: null }]), 'Could not make the group.');
  };

  return (
    <span className="prs-ws-pick">
      <button type="button" className="btn-ghost btn-tiny" disabled={busy} aria-expanded={open} onClick={() => setOpen(o => !o)}
        title="Review this PR together with others, in order">
        {current ? `In ${current.name} ${at}/${current.members.length}` : 'Add to group…'}
      </button>
      {open && (
        <div className="prs-ws-popover prg-pop" role="dialog" aria-label="Add to a review group">
          {groups.length > 0 && <div className="usage-dim prs-ws-scope">Your review groups</div>}
          <ul className="prs-ws-options">
            {groups.map(g => (
              <li key={g.id}>
                {g === current ? (
                  <button type="button" className="prg-pop-item" disabled={busy} onClick={() => { void removeFrom(g); }}>Take it out of {g.name}</button>
                ) : (
                  <button type="button" className="prg-pop-item" disabled={busy} onClick={() => { void addTo(g); }}>
                    {current ? 'Move to' : 'Add to'} {g.name} <span className="usage-dim">({g.members.length})</span>
                  </button>
                )}
              </li>
            ))}
          </ul>
          <div className="prg-add">
            <input autoFocus aria-label="New group name" placeholder="New group name" maxLength={80} value={name} disabled={busy}
              onChange={e => setName(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') { e.preventDefault(); create(); }
                if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); }
              }} />
            <button type="button" className="btn-ghost btn-tiny" disabled={busy || !name.trim()} onClick={create}>New group</button>
          </div>
        </div>
      )}
    </span>
  );
}

/**
 * The foot of Needs you: groups closed in the last 30 days (by hand, or once
 * every member was merged or closed), folded; each can be reopened or deleted.
 */
export function ClosedGroups({ groups, now, onChanged, onError }: {
  groups: PrReviewGroup[];
  now: number;
  onChanged: () => void;
  onError: (msg: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  if (groups.length === 0) return null;
  const run = async (fn: () => Promise<unknown>, failure: string) => {
    setBusy(true);
    onError('');
    try { await fn(); onChanged(); } catch (err) { onError(apiErrorText(err, failure)); } finally { setBusy(false); }
  };
  return (
    <>
      <button type="button" className="prso-deferred-toggle" aria-expanded={open} onClick={() => setOpen(o => !o)}>
        {open ? '▾' : '▸'} Closed groups ({groups.length})
      </button>
      {open && groups.map(g => (
        <div key={g.id} className="prg-closed">
          <span className="prg-name">{g.name}</span>
          <span className="usage-dim">{groupSize(g)} · closed {fmtAge(Math.max(0, now - Date.parse(g.closedAt ?? '')))} ago</span>
          <button type="button" className="btn-ghost btn-tiny" disabled={busy}
            onClick={() => { void run(() => prsApi.updateGroup(g.id, { closed: false }), 'Could not reopen the group.'); }}>Reopen</button>
          <button type="button" className="btn-ghost btn-tiny" disabled={busy}
            onClick={() => { void run(() => prsApi.deleteGroup(g.id), 'Could not delete the group.'); }}>Delete</button>
        </div>
      ))}
    </>
  );
}

/**
 * A suggested review group,
 * above the group cards: PRs that look like one piece of work, from a GitHub
 * stack or from their descriptions naming each other. Make a group… takes a
 * name (the first PR's title to start with); with a target, it adds them to
 * that group instead. Not these keeps it away until its set of PRs changes.
 * Nothing is grouped without one of those.
 */
export function SuggestionCard({ suggestion, groups, onChanged, onError }: {
  suggestion: PrGroupSuggestion;
  groups: PrReviewGroup[];
  onChanged: () => void;
  onError: (msg: string) => void;
}) {
  const [naming, setNaming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>, failure: string) => {
    setBusy(true);
    onError('');
    try { await fn(); setNaming(null); onChanged(); } catch (err) { onError(apiErrorText(err, failure)); } finally { setBusy(false); }
  };
  const accept = (name?: string) => {
    const plan = acceptSuggestion(suggestion, groups);
    if ('gone' in plan) { onError('That group is gone: reload the list.'); return; }
    if ('set' in plan) void run(() => prsApi.setGroupMembers(plan.set.id, plan.set.members), 'Could not add them to the group.');
    else void run(() => prsApi.createGroup((name ?? plan.create.name).trim(), plan.create.members), 'Could not make the group.');
  };
  return (
    <section className="prg-card prg-suggestion" aria-label="Suggested review group">
      <header className="prg-head">
        <span className="prg-name">Suggested{suggestion.target ? ` for ${suggestion.target.name}` : ' group'}</span>
        <span className="usage-dim">{suggestionWhy(suggestion)}</span>
        <span className="prg-actions">
          {suggestion.target
            ? <button type="button" className="btn-ghost btn-tiny prs-review" disabled={busy} onClick={() => accept()}>Add {suggestion.members.length} to {suggestion.target.name}</button>
            : naming === null && <button type="button" className="btn-ghost btn-tiny prs-review" disabled={busy} onClick={() => setNaming(suggestion.name)}>Make a group…</button>}
          <button type="button" className="btn-ghost btn-tiny" disabled={busy}
            onClick={() => { void run(() => prsApi.dismissSuggestion(suggestion.key), 'Could not dismiss it.'); }}>Not these</button>
        </span>
      </header>
      <ol className="prg-members prg-suggested">
        {suggestion.members.map(m => (
          <li key={`${m.repo}#${m.number}`} className="prg-suggested-member">
            <span className="prso-label">{memberLabel(m)}</span> <span className="prg-title">{m.title}</span>
          </li>
        ))}
      </ol>
      {naming !== null && (
        <div className="prg-add">
          <input autoFocus aria-label="Group name" maxLength={80} value={naming} disabled={busy}
            onChange={e => setNaming(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && naming.trim()) { e.preventDefault(); accept(naming); }
              if (e.key === 'Escape') { e.stopPropagation(); setNaming(null); }
            }} />
          <button type="button" className="btn-primary btn-tiny" disabled={busy || !naming.trim()} onClick={() => accept(naming)}>Make the group</button>
          <button type="button" className="btn-ghost btn-tiny" disabled={busy} onClick={() => setNaming(null)}>Cancel</button>
        </div>
      )}
    </section>
  );
}
