// A space's Share dialog in the simple UI, opened from the space's ⋮ in the
// sidebar (OpenItems.tsx): add people by email with a role (Can edit by
// default), change a role, remove someone or cancel an invite, leave, see and
// add the boxes whose agents reach the space, and copy the space's link (the menu has no Copy link of its own). Who may do what is chat/spaceShare.ts,
// mirroring routes/spaces.ts; the lists and every change go through
// hooks/useSpaceMembers, as the full UI's Members & boxes tab does. People
// added see the space's files; each keeps their own agents.
import React, { useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Dialog } from '../../components/Dialog';
import { PersonPicker } from '../../components/PersonPicker';
import { useSpaceMembers } from '../../hooks/useSpaceMembers';
import { boxFeed } from '../../services/boxFeed';
import { spacesApi, type SpaceView } from '../../services/api';
import { browserStorage, rememberPerson } from '../../utils/recentPeople';
import type { SpaceRole } from '../../utils/spaces';
import { DEFAULT_SHARE_ROLE, initials, SHARE_ROLE_HINT, SHARE_ROLE_LABEL, SHARE_ROLES, shareAbilities, spaceShareLink } from '../../chat/spaceShare';
import { SpaceSwatch } from './SpaceSwatch';

type Confirm = { message: React.ReactNode; confirmLabel: string; onConfirm: () => void };

export function SpaceShareDialog({ space, userId, onClose, onChanged, onLeft }: {
  space: SpaceView;
  userId: string | undefined;
  onClose: () => void;
  /** Someone or a box was added or removed: the sidebar's spaces should load again. */
  onChanged: () => void;
  /** The user left the space. */
  onLeft: () => void;
}) {
  const m = useSpaceMembers(space.name);
  const can = shareAbilities(space.role, Boolean(space.readOnly));
  const myBoxes = useSyncExternalStore(boxFeed.subscribe, boxFeed.getSnapshot);
  const [email, setEmail] = useState('');
  const [pickedName, setPickedName] = useState<string | undefined>();
  const [role, setRole] = useState<SpaceRole>(DEFAULT_SHARE_ROLE);
  const [boxesOpen, setBoxesOpen] = useState(false);
  const [boxToAdd, setBoxToAdd] = useState('');
  const [copied, setCopied] = useState(false);
  const [confirm, setConfirm] = useState<Confirm | null>(null);

  const owners = m.members.filter(p => p.role === 'owner');
  const granted = new Set(m.boxes.map(b => b.id));
  const addable = myBoxes.filter(b => b.status !== 'terminated' && !granted.has(b.id));
  const changed = () => onChanged();

  const add = (e: React.FormEvent) => {
    e.preventDefault();
    const who = email.trim();
    if (!who) return;
    void m.act(async () => {
      const r = await spacesApi.addMember(space.name, who, role);
      rememberPerson(browserStorage(), { email: who, displayName: pickedName });
      m.setNote(r.invite
        ? `${who} gets access when they first sign in to termag.`
        : `${r.member?.displayName || who} ${role === 'owner' ? 'is now an owner' : role === 'editor' ? 'can now edit' : 'can now view'} ${space.name}.`);
    }, 'Could not add them', () => { setEmail(''); setPickedName(undefined); changed(); });
  };

  const link = spaceShareLink(window.location.origin, import.meta.env.BASE_URL, space.name);
  const copyLink = () => {
    navigator.clipboard?.writeText(link).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  };

  return createPortal(
    <Dialog
      className="chat-launch-dialog chat-share-dialog"
      title={<span className="chat-share-title"><SpaceSwatch space={space.name} />Share {space.name}</span>}
      onClose={onClose}
    >
      <p className="chat-launch-dialog-note">
        {can.manage
          ? <>People you add see {space.name} in their sidebar and can open its files. Each person keeps their own agents.</>
          : <>Who can open {space.name}, and the boxes whose agents reach it.</>}
      </p>
      {/* The space's link, the one way to copy it: near the top, where it's seen first. */}
      <div className="chat-share-link">
        <input readOnly value={link} aria-label={`Link to ${space.name}`} onFocus={e => e.currentTarget.select()} />
        <button type="button" className="chat-share-secondary chat-share-copy" onClick={copyLink}>
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <path fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" d="M6.5 9.5l3-3M7 4.5l1-1a2.8 2.8 0 0 1 4 4l-1 1M9 11.5l-1 1a2.8 2.8 0 0 1-4-4l1-1" />
          </svg>
          {copied ? 'Link copied' : 'Copy link'}
        </button>
        <span className="chat-share-sub chat-share-link-hint">Only people in {space.name} can open it</span>
      </div>
      {space.readOnly && <div className="chat-share-gate" role="status">This space has no owner, so it is read-only. An admin can make someone its owner.</div>}
      {m.error && (
        <div className="chat-share-error" role="alert">
          <span>{m.error}</span>
          <button type="button" aria-label="Dismiss" onClick={() => m.setError('')}>×</button>
        </div>
      )}
      {m.note && <div className="chat-share-note" role="status">{m.note}</div>}

      {can.addPeople === 'yes' && (
        <form className="chat-share-add" onSubmit={add} aria-label={`Add people to ${space.name}`}>
          <div className="chat-share-who">
            <PersonPicker required value={email} placeholder="Add people by name or email" ariaLabel="Email"
              onChange={(next, name) => { setEmail(next); setPickedName(name); }} />
          </div>
          <select aria-label="Role" value={role} title={SHARE_ROLE_HINT[role]} onChange={e => setRole(e.target.value as SpaceRole)}>
            {SHARE_ROLES.map(r => <option key={r} value={r}>{SHARE_ROLE_LABEL[r]}</option>)}
          </select>
          <button type="submit" className="chat-share-primary" disabled={!m.loaded || !email.trim()}>Add</button>
        </form>
      )}
      {can.addPeople === 'not_owner' && !space.readOnly && (
        <div className="chat-share-gate">
          You can {space.role === 'viewer' ? 'view' : 'edit'} this space. Only its owners add people
          {owners[0] ? <>: ask {owners[0].displayName || owners[0].email}</> : null}.
        </div>
      )}

      <section className="chat-share-section" aria-label="People">
        <div className="chat-menu-heading">People{m.loaded ? ` · ${m.members.length + m.invites.length}` : ''}</div>
        {!m.loaded && !m.error && <div className="chat-share-loading">Loading…</div>}
        <ul className="chat-share-list">
          {m.members.map(p => {
            const self = p.userId === userId;
            const lastOwner = p.role === 'owner' && owners.length === 1;
            const name = p.displayName || p.email;
            return (
              <li key={p.userId} className="chat-share-row">
                <span className="chat-share-avatar" aria-hidden="true">{initials(name)}</span>
                <span className="chat-share-who-text">
                  <span className="chat-share-name">{name}{self ? ' (you)' : ''}</span>
                  <span className="chat-share-sub">{p.email}</span>
                </span>
                {can.manage && !self ? (
                  <select aria-label={`Role of ${p.email}`} value={p.role}
                    onChange={e => { const next = e.target.value; void m.act(() => spacesApi.setRole(space.name, p.userId, next), 'Could not change the role'); }}>
                    {SHARE_ROLES.map(r => <option key={r} value={r}>{SHARE_ROLE_LABEL[r]}</option>)}
                  </select>
                ) : <span className="chat-share-role">{SHARE_ROLE_LABEL[p.role]}</span>}
                {can.manage && !self && (
                  <button type="button" className="chat-share-action" aria-label={`Remove ${p.email}`} onClick={() => setConfirm({
                    message: <>Remove {p.email} from <b>{space.name}</b>? The boxes they added lose access too.</>,
                    confirmLabel: 'Remove',
                    onConfirm: () => void m.act(() => spacesApi.removeMember(space.name, p.userId), 'Could not remove them', changed),
                  })}>Remove</button>
                )}
                {self && (
                  <button type="button" className="chat-share-action" disabled={lastOwner}
                    title={lastOwner ? 'Make someone else an owner first' : undefined}
                    onClick={() => setConfirm({
                      message: <>Leave <b>{space.name}</b>? The boxes you added lose access too.</>,
                      confirmLabel: 'Leave',
                      onConfirm: () => void m.act(() => spacesApi.removeMember(space.name, p.userId), 'Could not leave', onLeft),
                    })}>Leave</button>
                )}
              </li>
            );
          })}
          {m.invites.map(i => (
            <li key={i.id} className="chat-share-row chat-share-invited">
              <span className="chat-share-avatar" aria-hidden="true">{initials(i.email)}</span>
              <span className="chat-share-who-text">
                <span className="chat-share-name">{i.email}</span>
                <span className="chat-share-sub">Invited · not signed in to termag yet</span>
              </span>
              <span className="chat-share-role">{SHARE_ROLE_LABEL[i.role]}</span>
              {can.manage && (
                <button type="button" className="chat-share-action" aria-label={`Cancel the invite to ${i.email}`}
                  onClick={() => void m.act(() => spacesApi.removeInvite(space.name, i.id), 'Could not cancel the invite')}>Cancel</button>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section className="chat-share-section" aria-label="Boxes">
        <button type="button" className="chat-share-disclose" aria-expanded={boxesOpen} onClick={() => setBoxesOpen(o => !o)}>
          <span className="chat-group-caret" aria-hidden="true" />
          <span className="chat-menu-heading">Boxes{m.loaded ? ` · ${m.boxes.length}` : ''}</span>
          <span className="chat-share-sub">Their agents reach the space with their owner's role</span>
        </button>
        {boxesOpen && (
          <>
            <ul className="chat-share-list">
              {m.boxes.map(b => (
                <React.Fragment key={b.id}>
                  <li className="chat-share-row">
                    <span className="chat-share-box-dot" data-status={b.status} aria-hidden="true" />
                    <span className="chat-share-who-text">
                      <span className="chat-share-name">{b.name}</span>
                      <span className="chat-share-sub">{b.mine ? 'Your box' : b.ownerEmail ?? ''} · {b.status}</span>
                    </span>
                    {(b.mine || can.manage) && (
                      <button type="button" className="chat-share-action" aria-label={`Remove box ${b.name}`}
                        onClick={() => void m.act(() => spacesApi.removeBox(space.name, b.id), 'Could not remove the box', changed)}>Remove</button>
                    )}
                  </li>
                  {b.children.map(c => (
                    <li key={`${b.id}:${c.id}`} className="chat-share-row chat-share-inherited">
                      <span className="chat-share-box-dot" aria-hidden="true" />
                      <span className="chat-share-who-text">
                        <span className="chat-share-name">↳ {c.name}</span>
                        <span className="chat-share-sub">through {b.name}</span>
                      </span>
                    </li>
                  ))}
                </React.Fragment>
              ))}
              {m.loaded && m.boxes.length === 0 && <li className="chat-share-loading">No boxes reach this space yet.</li>}
            </ul>
            {can.addBoxes && addable.length > 0 && (
              <form className="chat-share-add" onSubmit={e => {
                e.preventDefault();
                if (boxToAdd) void m.act(() => spacesApi.addBox(space.name, boxToAdd), 'Could not add the box', () => { setBoxToAdd(''); changed(); });
              }}>
                <select aria-label="Box to add" value={boxToAdd} onChange={e => setBoxToAdd(e.target.value)}>
                  <option value="">Add one of your boxes…</option>
                  {addable.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
                <button type="submit" className="chat-share-secondary" disabled={!boxToAdd}>Add</button>
              </form>
            )}
          </>
        )}
      </section>

      <div className="chat-share-foot">
        <button type="button" className="chat-share-primary" onClick={onClose}>Done</button>
      </div>
      {confirm && (
        <ConfirmDialog message={confirm.message} confirmLabel={confirm.confirmLabel}
          onConfirm={() => { setConfirm(null); confirm.onConfirm(); }} onCancel={() => setConfirm(null)} />
      )}
    </Dialog>,
    document.body,
  );
}
