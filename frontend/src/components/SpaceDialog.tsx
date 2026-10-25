import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Dialog } from './Dialog';
import { PersonPicker } from './PersonPicker';
import { browserStorage, rememberPerson } from '../utils/recentPeople';
import { ConfirmDialog } from './ConfirmDialog';
import { FLAGS, useFlag } from '../flags';
import { REPLAY_BLOCK_CLASS } from '../observability';
import { spacesApi, type SpaceBoxGrant, type SpaceEvent, type SpaceInvite, type SpaceMember, type SpaceTreeDir, type SpaceTreeFile, type SpaceView } from '../services/api';
import { downloadFile, errorMessage, UploadAborted, uploadFile } from '../services/spaceTransfer';
import type { Instance } from '../types';
import {
  actionLabel, breadcrumbs, collectDropped, formatBytes, nameError, parentPrefix, relPathError, prettyText, previewKind, roleAtLeast,
  SPACE_NAME_HINT, SPACE_NAME_RE, SPACE_ROLES, spaceFileLink, TEXT_PREVIEW_MAX_BYTES, usageLabel,
} from '../utils/spaces';
import type { DropEntry, DroppedFile } from '../utils/spaces';

export type SpaceTab = 'files' | 'members' | 'activity';

interface UploadRow { id: number; path: string; size: number; sent: number; error?: string; done?: boolean; abort: AbortController }

interface Preview { path: string; kind: 'image' | 'pdf' | 'text'; url?: string; text?: string; truncated?: boolean; error?: string }

type Confirm = { message: React.ReactNode; confirmLabel: string; onConfirm: () => void };

let uploadSeq = 0;

/**
 * One space: its files (tree, upload, download, preview, move, delete), its
 * members and boxes, and (for owners) its activity. Opened from the sidebar's
 * Spaces section.
 */
export function SpaceDialog({ space: initial, tab: initialTab = 'files', myBoxes, userId, onClose, onChanged }: {
  space: SpaceView;
  tab?: SpaceTab;
  myBoxes: Instance[];
  userId: string | undefined;
  onClose: () => void;
  /** The space list should be reloaded: a rename, delete, leave or upload changed it. */
  onChanged: () => void;
}) {
  const [space, setSpace] = useState(initial);
  const [tab, setTab] = useState<SpaceTab>(initialTab);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const isOwner = space.role === 'owner';
  const canWrite = roleAtLeast(space.role, 'editor') && !space.readOnly;

  return (
    <Dialog className={`space-dialog ${REPLAY_BLOCK_CLASS}`} labelledBy="space-dialog-title" onClose={onClose}>
      <div className="space-head">
        <div className="np-dialog-title" id="space-dialog-title">{space.name}</div>
        <span className="space-role">{space.role}{space.readOnly ? ' · read-only' : ''}</span>
        <span className="space-usage" title="Includes old versions kept after overwrites and deletes">{usageLabel(space.usedBytes, space.quotaBytes)}</span>
        <button type="button" className="btn-tiny space-close" aria-label="Close" onClick={onClose}>×</button>
      </div>
      {space.description && <div className="space-description">{space.description}</div>}
      {space.readOnly && (
        <div className="box-lifecycle-warning" role="status">This space has no owner, so it is read-only. An admin can make someone its owner.</div>
      )}
      <div className="space-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'files'} className={tab === 'files' ? 'active' : ''} onClick={() => setTab('files')}>Files</button>
        <button type="button" role="tab" aria-selected={tab === 'members'} className={tab === 'members' ? 'active' : ''} onClick={() => setTab('members')}>Members &amp; boxes</button>
        {isOwner && (
          <button type="button" role="tab" aria-selected={tab === 'activity'} className={tab === 'activity' ? 'active' : ''} onClick={() => setTab('activity')}>Activity</button>
        )}
      </div>
      {tab === 'files' && <FilesTab space={space} canWrite={canWrite} setConfirm={setConfirm} onChanged={onChanged} />}
      {tab === 'members' && (
        <MembersTab
          space={space}
          myBoxes={myBoxes}
          userId={userId}
          setConfirm={setConfirm}
          onRenamed={s => { setSpace(s); onChanged(); }}
          onGone={() => { onChanged(); onClose(); }}
        />
      )}
      {tab === 'activity' && isOwner && <ActivityTab space={space} myBoxes={myBoxes} />}
      {confirm && (
        <ConfirmDialog
          message={confirm.message}
          confirmLabel={confirm.confirmLabel}
          onConfirm={() => { setConfirm(null); confirm.onConfirm(); }}
          onCancel={() => setConfirm(null)}
        />
      )}
    </Dialog>
  );
}

// ---- files ----

function FilesTab({ space, canWrite, setConfirm, onChanged }: {
  space: SpaceView;
  canWrite: boolean;
  setConfirm: (c: Confirm) => void;
  onChanged: () => void;
}) {
  const [prefix, setPrefix] = useState('');
  const [dirs, setDirs] = useState<SpaceTreeDir[]>([]);
  const [files, setFiles] = useState<SpaceTreeFile[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // A folder exists in S3 only once something is in it; one made here waits for its first upload.
  const [pendingDirs, setPendingDirs] = useState<string[]>([]);
  const [newFolder, setNewFolder] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ path: string; value: string } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [uploads, setUploads] = useState<UploadRow[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const loadSeq = useRef(0);
  const prefixRef = useRef(prefix);
  prefixRef.current = prefix;

  const load = useCallback(async (p: string, more: string | null = null) => {
    const seq = ++loadSeq.current;
    setLoading(true);
    setError('');
    try {
      const t = await spacesApi.tree(space.name, p, more);
      if (seq !== loadSeq.current) return;
      setDirs(d => (more ? [...d, ...t.dirs] : t.dirs));
      setFiles(f => (more ? [...f, ...t.files] : t.files));
      setCursor(t.nextCursor);
    } catch (err) {
      if (seq === loadSeq.current) setError(errorMessage(err, 'Could not list the space'));
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, [space.name]);

  useEffect(() => { void load(prefix); }, [load, prefix]);

  const shownDirs = useMemo(() => {
    const known = new Set(dirs.map(d => d.path));
    const extra = pendingDirs.filter(p => parentPrefix(p) === prefix && !known.has(p)).map(p => ({ name: p.slice(prefix.length, -1), path: p }));
    return [...dirs, ...extra].sort((a, b) => a.name.localeCompare(b.name));
  }, [dirs, pendingDirs, prefix]);

  function startUploads(chosen: DroppedFile[]) {
    if (chosen.length === 0) return;
    const rows: UploadRow[] = chosen.map(({ file: f, rel }) => ({ id: ++uploadSeq, path: prefix + rel, size: f.size, sent: 0, abort: new AbortController() }));
    setUploads(u => [...u, ...rows]);
    const update = (id: number, patch: Partial<UploadRow>) => setUploads(u => u.map(r => (r.id === id ? { ...r, ...patch } : r)));
    void (async () => {
      for (const [i, { file, rel }] of chosen.entries()) {
        const row = rows[i];
        const bad = relPathError(rel);
        if (bad) { update(row.id, { error: bad }); continue; }
        try {
          await uploadFile(space.name, row.path, file, sent => update(row.id, { sent }), row.abort.signal);
          update(row.id, { done: true, sent: file.size });
        } catch (err) {
          update(row.id, { error: err instanceof UploadAborted ? 'Cancelled' : errorMessage(err, 'Upload failed') });
        }
      }
      await load(prefixRef.current);
      onChanged();
      setTimeout(() => setUploads(u => u.filter(r => !rows.some(x => x.id === r.id) || r.error)), 2500);
    })();
  }

  async function openPreview(f: SpaceTreeFile) {
    const kind = previewKind(f.path);
    if (!kind) return;
    setPreview({ path: f.path, kind });
    try {
      const { url } = await spacesApi.download(space.name, f.path, true);
      if (kind !== 'text') { setPreview({ path: f.path, kind, url }); return; }
      const res = await fetch(url, f.size > TEXT_PREVIEW_MAX_BYTES ? { headers: { Range: `bytes=0-${TEXT_PREVIEW_MAX_BYTES - 1}` } } : {});
      if (!res.ok && res.status !== 206) throw new Error(`Storage answered HTTP ${res.status}`);
      setPreview({ path: f.path, kind, text: prettyText(f.path, await res.text()), truncated: f.size > TEXT_PREVIEW_MAX_BYTES });
    } catch (err) {
      setPreview({ path: f.path, kind, error: errorMessage(err, 'Could not load the preview') });
    }
  }

  async function download(path: string) {
    try { await downloadFile(space.name, path); } catch (err) { setError(errorMessage(err, 'Download failed')); }
  }

  async function copyLink(path: string) {
    const link = spaceFileLink(window.location.origin, import.meta.env.BASE_URL, space.name, path);
    try {
      await navigator.clipboard.writeText(link);
      setCopied(path);
      setTimeout(() => setCopied(c => (c === path ? null : c)), 1500);
    } catch {
      setError(`Could not copy the link; it is ${link}`);
    }
  }

  function remove(path: string, folder: boolean) {
    setConfirm({
      message: folder
        ? <>Delete the folder <b>{path}</b> and everything in it? Old versions stay in storage, but nothing in termag brings them back.</>
        : <>Delete <b>{path}</b>? The old version stays in storage, but nothing in termag brings it back.</>,
      confirmLabel: 'Delete',
      onConfirm: async () => {
        try {
          const r = await spacesApi.removeFiles(space.name, path, folder);
          if (!r.ok) setError(`Some files were not deleted: ${r.failed.join(', ')}`);
          setPendingDirs(d => d.filter(p => !p.startsWith(path)));
          await load(prefix);
          onChanged();
        } catch (err) { setError(errorMessage(err, 'Delete failed')); }
      },
    });
  }

  async function rename(from: string, value: string) {
    const folder = from.endsWith('/');
    const bad = nameError(value);
    if (bad) { setError(bad); return; }
    const to = parentPrefix(from) + value.trim() + (folder ? '/' : '');
    setRenaming(null);
    if (to === from) return;
    try {
      const r = await spacesApi.move(space.name, from, to);
      if (!r.ok) setError(`Some files were not moved: ${r.failed.join(', ')}`);
      await load(prefix);
    } catch (err) { setError(errorMessage(err, 'Rename failed')); }
  }

  function addFolder(value: string) {
    const bad = nameError(value);
    if (bad) { setError(bad); return; }
    const path = `${prefix}${value.trim()}/`;
    setPendingDirs(d => (d.includes(path) ? d : [...d, path]));
    setNewFolder(null);
    setPrefix(path);
  }

  const crumbs = breadcrumbs(space.name, prefix);
  const empty = !loading && shownDirs.length === 0 && files.length === 0;

  return (
    <div
      className={`space-files${dragging ? ' space-dropping' : ''}`}
      onDragOver={e => { if (canWrite && e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragging(true); } }}
      onDragLeave={e => { if (e.currentTarget === e.target) setDragging(false); }}
      onDrop={e => {
        if (!canWrite) return;
        e.preventDefault();
        setDragging(false);
        const entries = Array.from(e.dataTransfer.items).filter(item => item.kind === 'file').map(item => (item.webkitGetAsEntry?.() ?? null) as DropEntry | null);
        const files = Array.from(e.dataTransfer.files);
        collectDropped(entries, files).then(startUploads, err => setError(errorMessage(err, 'Could not read the dropped folder')));
      }}
    >
      <div className="space-toolbar">
        <nav className="space-crumbs" aria-label="Folder">
          {crumbs.map((c, i) => (
            <React.Fragment key={c.prefix}>
              {i > 0 && <span className="space-crumb-sep">/</span>}
              {i === crumbs.length - 1
                ? <span className="space-crumb-current">{c.name}</span>
                : <button type="button" className="space-crumb" onClick={() => setPrefix(c.prefix)}>{c.name}</button>}
            </React.Fragment>
          ))}
        </nav>
        <span className="space-toolbar-actions">
          <button type="button" className="btn-tiny" onClick={() => void load(prefix)} title="Refresh">↻</button>
          {canWrite && <button type="button" className="btn-tiny" onClick={() => setNewFolder('')}>New folder</button>}
          {canWrite && <button type="button" className="btn-tiny btn-primary" onClick={() => fileInput.current?.click()}>Upload</button>}
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            aria-label="Upload files"
            onChange={e => { if (e.target.files) startUploads(Array.from(e.target.files, file => ({ file, rel: file.name }))); e.target.value = ''; }}
          />
        </span>
      </div>
      {error && <div className="error-banner">{error}<button onClick={() => setError('')}>×</button></div>}
      {newFolder !== null && (
        <form className="inline-form space-inline-form" onSubmit={e => { e.preventDefault(); addFolder(newFolder); }}>
          <input autoFocus value={newFolder} placeholder="folder name" onChange={e => setNewFolder(e.target.value)}
            onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setNewFolder(null); } }} />
          <button type="submit">Create</button>
        </form>
      )}
      {uploads.length > 0 && (
        <ul className="space-uploads">
          {uploads.map(u => (
            <li key={u.id} className={u.error ? 'space-upload-failed' : ''}>
              <span className="space-upload-name">{u.path}</span>
              <progress max={Math.max(u.size, 1)} value={u.done ? Math.max(u.size, 1) : u.sent} />
              <span className="space-upload-state">
                {u.error ?? (u.done ? 'done' : `${formatBytes(u.sent)} of ${formatBytes(u.size)}`)}
              </span>
              {!u.done && !u.error && <button type="button" className="btn-tiny" onClick={() => u.abort.abort()}>Cancel</button>}
              {u.error && <button type="button" className="btn-tiny" onClick={() => setUploads(x => x.filter(r => r.id !== u.id))}>×</button>}
            </li>
          ))}
        </ul>
      )}
      <ul className="space-tree">
        {prefix && (
          <li className="space-row space-row-up">
            <button type="button" className="space-name" onClick={() => setPrefix(parentPrefix(prefix))}>..</button>
          </li>
        )}
        {shownDirs.map(d => (
          <li key={d.path} className="space-row">
            {renaming?.path === d.path ? (
              <RenameForm value={renaming.value} onChange={v => setRenaming({ path: d.path, value: v })} onSubmit={() => void rename(d.path, renaming.value)} onCancel={() => setRenaming(null)} />
            ) : (
              <button type="button" className="space-name space-dir" onClick={() => setPrefix(d.path)}>{d.name}/</button>
            )}
            <span className="space-size">{pendingDirs.includes(d.path) && !dirs.some(x => x.path === d.path) ? 'empty' : ''}</span>
            <span className="space-modified" />
            <span className="space-actions">
              {canWrite && dirs.some(x => x.path === d.path) && <button type="button" className="btn-tiny" onClick={() => setRenaming({ path: d.path, value: d.name })}>Rename</button>}
              {canWrite && dirs.some(x => x.path === d.path) && <button type="button" className="btn-tiny btn-danger" onClick={() => remove(d.path, true)}>Delete</button>}
            </span>
          </li>
        ))}
        {files.map(f => (
          <li key={f.path} className="space-row">
            {renaming?.path === f.path ? (
              <RenameForm value={renaming.value} onChange={v => setRenaming({ path: f.path, value: v })} onSubmit={() => void rename(f.path, renaming.value)} onCancel={() => setRenaming(null)} />
            ) : previewKind(f.path) ? (
              <button type="button" className="space-name" title="Preview" onClick={() => void openPreview(f)}>{f.name}</button>
            ) : (
              <span className="space-name">{f.name}</span>
            )}
            <span className="space-size">{formatBytes(f.size)}</span>
            <span className="space-modified">{f.modifiedAt ? new Date(f.modifiedAt).toLocaleString() : ''}</span>
            <span className="space-actions">
              <button type="button" className="btn-tiny" onClick={() => void download(f.path)}>Download</button>
              <button type="button" className="btn-tiny" title="Copy a link that opens this file for anyone who can read the space" onClick={() => void copyLink(f.path)}>
                {copied === f.path ? 'Copied' : 'Copy link'}
              </button>
              {canWrite && <button type="button" className="btn-tiny" onClick={() => setRenaming({ path: f.path, value: f.name })}>Rename</button>}
              {canWrite && <button type="button" className="btn-tiny btn-danger" onClick={() => remove(f.path, false)}>Delete</button>}
            </span>
          </li>
        ))}
        {loading && <li className="space-row space-row-note">Loading…</li>}
        {empty && (
          <li className="space-row space-row-note">
            {prefix ? 'This folder is empty.' : 'This space is empty.'}
            {canWrite && ' Drop files here or use Upload.'}
          </li>
        )}
      </ul>
      {cursor && !loading && <button type="button" className="btn-tiny space-more" onClick={() => void load(prefix, cursor)}>Load more</button>}
      <div className="space-cli-hint">
        From a box this space reaches: <code>termag space get {space.name}:{prefix || '<path>'}</code>
      </div>
      {preview && <PreviewPane preview={preview} onClose={() => setPreview(null)} onDownload={() => void download(preview.path)} />}
    </div>
  );
}

function RenameForm({ value, onChange, onSubmit, onCancel }: { value: string; onChange: (v: string) => void; onSubmit: () => void; onCancel: () => void }) {
  return (
    <form className="space-rename" onSubmit={e => { e.preventDefault(); onSubmit(); }}>
      <input autoFocus value={value} onChange={e => onChange(e.target.value)}
        onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancel(); } }} />
      <button type="submit" className="btn-tiny">Save</button>
    </form>
  );
}

function PreviewPane({ preview, onClose, onDownload }: { preview: Preview; onClose: () => void; onDownload: () => void }) {
  return (
    <div className="space-preview">
      <div className="space-preview-head">
        <span className="space-preview-name">{preview.path}</span>
        <button type="button" className="btn-tiny" onClick={onDownload}>Download</button>
        <button type="button" className="btn-tiny" aria-label="Close preview" onClick={onClose}>×</button>
      </div>
      <div className="space-preview-body">
        {preview.error && <div className="error-text">{preview.error}</div>}
        {!preview.error && !preview.url && preview.text === undefined && <div className="usage-dim">Loading…</div>}
        {preview.kind === 'image' && preview.url && <img src={preview.url} alt={preview.path} />}
        {preview.kind === 'pdf' && preview.url && (
          <a href={preview.url} target="_blank" rel="noopener noreferrer">Open the PDF in a new tab</a>
        )}
        {preview.kind === 'text' && preview.text !== undefined && (
          <>
            <pre className="space-preview-text">{preview.text}</pre>
            {preview.truncated && <div className="usage-dim">Showing the first {formatBytes(TEXT_PREVIEW_MAX_BYTES)}; download for the rest.</div>}
          </>
        )}
      </div>
    </div>
  );
}

// ---- members and boxes ----

function MembersTab({ space, myBoxes, userId, setConfirm, onRenamed, onGone }: {
  space: SpaceView;
  myBoxes: Instance[];
  userId: string | undefined;
  setConfirm: (c: Confirm) => void;
  onRenamed: (s: SpaceView) => void;
  onGone: () => void;
}) {
  const [members, setMembers] = useState<SpaceMember[]>([]);
  const [invites, setInvites] = useState<SpaceInvite[]>([]);
  const [boxes, setBoxes] = useState<SpaceBoxGrant[]>([]);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [email, setEmail] = useState('');
  const [pickedName, setPickedName] = useState<string | undefined>();
  const [role, setRole] = useState<string>('editor');
  const [boxToAdd, setBoxToAdd] = useState('');
  const [newName, setNewName] = useState<string | null>(null);
  const isOwner = space.role === 'owner' && !space.readOnly;
  const sharingOn = useFlag(FLAGS.spacesSharing, false);
  const canAddBox = roleAtLeast(space.role, 'editor') && !space.readOnly;

  const load = useCallback(async () => {
    try {
      const [m, b] = await Promise.all([spacesApi.members(space.name), spacesApi.boxes(space.name)]);
      setMembers(m.members);
      setInvites(m.invites);
      setBoxes(b.boxes);
    } catch (err) { setError(errorMessage(err, 'Could not load members')); }
  }, [space.name]);

  useEffect(() => { void load(); }, [load]);

  async function act(fn: () => Promise<unknown>, fallback: string, after?: () => void) {
    setError('');
    setNote('');
    try { await fn(); after?.(); await load(); } catch (err) { setError(errorMessage(err, fallback)); }
  }

  const granted = new Set(boxes.map(b => b.id));
  const inherited = new Set(boxes.flatMap(b => b.children.map(c => c.id)));
  const addable = myBoxes.filter(b => b.status !== 'terminated' && !granted.has(b.id));

  return (
    <div className="space-members">
      {error && <div className="error-banner">{error}<button onClick={() => setError('')}>×</button></div>}
      {note && <div className="space-note" role="status">{note}</div>}

      <h4>People</h4>
      <ul className="space-member-list">
        {members.map(m => (
          <li key={m.userId} className="space-member">
            <span className="space-member-name" title={m.email}>{m.displayName || m.email}{m.userId === userId ? ' (you)' : ''}</span>
            <span className="space-member-email">{m.email}</span>
            {isOwner ? (
              <select
                aria-label={`Role of ${m.email}`}
                value={m.role}
                onChange={e => void act(() => spacesApi.setRole(space.name, m.userId, e.target.value), 'Could not change the role')}
              >
                {SPACE_ROLES.map(r => <option key={r} value={r}>{r}</option>)}
              </select>
            ) : <span className="space-role">{m.role}</span>}
            {(isOwner || m.userId === userId) && (
              <button
                type="button"
                className="btn-tiny btn-danger"
                onClick={() => setConfirm({
                  message: m.userId === userId
                    ? <>Leave <b>{space.name}</b>? The boxes you added lose access too.</>
                    : <>Remove {m.email} from <b>{space.name}</b>? The boxes they added lose access too.</>,
                  confirmLabel: m.userId === userId ? 'Leave' : 'Remove',
                  onConfirm: () => void act(() => spacesApi.removeMember(space.name, m.userId), 'Could not remove the member',
                    m.userId === userId ? onGone : undefined),
                })}
              >{m.userId === userId ? 'Leave' : 'Remove'}</button>
            )}
          </li>
        ))}
        {invites.map(i => (
          <li key={i.id} className="space-member space-member-invited">
            <span className="space-member-name">{i.email}</span>
            <span className="space-member-email">not signed in to termag yet</span>
            <span className="space-role">{i.role}</span>
            {isOwner && <button type="button" className="btn-tiny btn-danger" onClick={() => void act(() => spacesApi.removeInvite(space.name, i.id), 'Could not cancel the invite')}>Cancel</button>}
          </li>
        ))}
      </ul>
      {isOwner && !sharingOn && (
        <div className="usage-dim space-hint">Sharing spaces with other people is not turned on for you yet.</div>
      )}
      {isOwner && sharingOn && (
        <form
          className="inline-form space-inline-form"
          onSubmit={e => {
            e.preventDefault();
            const who = email.trim();
            void act(async () => {
              const r = await spacesApi.addMember(space.name, who, role);
              rememberPerson(browserStorage(), { email: who, displayName: pickedName });
              setNote(r.invite ? `${who} becomes ${role} when they first sign in to termag.` : `${who} is now ${role}.`);
            }, 'Could not add the member', () => { setEmail(''); setPickedName(undefined); });
          }}
        >
          <PersonPicker required value={email} placeholder="name or teammate@example.com" ariaLabel="Email" onChange={(next, name) => { setEmail(next); setPickedName(name); }} />
          <select aria-label="Role" value={role} onChange={e => setRole(e.target.value)}>
            {SPACE_ROLES.map(r => <option key={r} value={r}>{r}</option>)}
          </select>
          <button type="submit">Add</button>
        </form>
      )}

      <h4>Boxes</h4>
      <div className="usage-dim space-hint">
        A box you add acts with your role, and loses access when you leave the space. Boxes started from it reach the space through it.
      </div>
      <ul className="space-member-list">
        {boxes.map(b => (
          <React.Fragment key={b.id}>
            <li className="space-member">
              <span className="space-member-name">{b.name}</span>
              <span className="space-member-email">{b.mine ? 'your box' : b.ownerEmail ?? ''}</span>
              <span className="space-role">{b.status}</span>
              {(b.mine || isOwner) && (
                <button type="button" className="btn-tiny btn-danger" onClick={() => void act(() => spacesApi.removeBox(space.name, b.id), 'Could not remove the box')}>Remove</button>
              )}
            </li>
            {b.children.map(c => (
              <li key={`${b.id}:${c.id}`} className="space-member space-member-inherited">
                <span className="space-member-name">↳ {c.name}</span>
                <span className="space-member-email">inherited through {b.name}</span>
                <span className="space-role" />
              </li>
            ))}
          </React.Fragment>
        ))}
        {boxes.length === 0 && <li className="space-row-note">No boxes reach this space yet.</li>}
      </ul>
      {canAddBox && addable.length > 0 && (
        <form
          className="inline-form space-inline-form"
          onSubmit={e => { e.preventDefault(); if (boxToAdd) void act(() => spacesApi.addBox(space.name, boxToAdd), 'Could not add the box', () => setBoxToAdd('')); }}
        >
          <select aria-label="Box to add" value={boxToAdd} onChange={e => setBoxToAdd(e.target.value)}>
            <option value="">Add one of your boxes…</option>
            {addable.map(b => <option key={b.id} value={b.id}>{b.name}{inherited.has(b.id) ? ' (already inherits)' : ''}</option>)}
          </select>
          <button type="submit" disabled={!boxToAdd}>Add</button>
        </form>
      )}

      {isOwner && (
        <>
          <h4>Space</h4>
          {newName === null ? (
            <div className="space-owner-actions">
              <button type="button" className="btn-tiny" onClick={() => setNewName(space.name)}>Rename</button>
              <button
                type="button"
                className="btn-tiny btn-danger"
                onClick={() => setConfirm({
                  message: <>Delete <b>{space.name}</b> and every file in it? Its boxes lose access at once and the files are purged within a day. This cannot be undone.</>,
                  confirmLabel: 'Delete space',
                  onConfirm: () => void act(() => spacesApi.remove(space.name), 'Could not delete the space', onGone),
                })}
              >Delete space</button>
            </div>
          ) : (
            <form
              className="inline-form space-inline-form"
              onSubmit={e => {
                e.preventDefault();
                if (!SPACE_NAME_RE.test(newName)) { setError(`A space name is ${SPACE_NAME_HINT}`); return; }
                void act(async () => { const r = await spacesApi.update(space.name, { name: newName }); onRenamed(r.space); }, 'Could not rename the space', () => setNewName(null));
              }}
            >
              <input autoFocus value={newName} aria-label="New name" onChange={e => setNewName(e.target.value)} />
              <button type="submit">Save</button>
              <button type="button" className="btn-ghost" onClick={() => setNewName(null)}>Cancel</button>
            </form>
          )}
          <div className="usage-dim space-hint">Renaming breaks <code>{space.name}:</code> paths in scripts on boxes.</div>
        </>
      )}
    </div>
  );
}

// ---- activity ----

function ActivityTab({ space, myBoxes }: { space: SpaceView; myBoxes: Instance[] }) {
  const [events, setEvents] = useState<SpaceEvent[] | null>(null);
  const [members, setMembers] = useState<SpaceMember[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    Promise.all([spacesApi.events(space.name, 200), spacesApi.members(space.name)])
      .then(([e, m]) => { if (live) { setEvents(e.events); setMembers(m.members); } })
      .catch(err => { if (live) setError(errorMessage(err, 'Could not load activity')); });
    return () => { live = false; };
  }, [space.name]);

  const who = (e: SpaceEvent) => {
    const person = members.find(m => m.userId === e.actorUserId)?.email ?? 'someone';
    if (!e.actorInstanceId) return person;
    const box = myBoxes.find(b => b.id === e.actorInstanceId)?.name ?? 'a box';
    return `${box} (${person})`;
  };

  if (error) return <div className="error-banner">{error}</div>;
  if (!events) return <div className="usage-dim">Loading…</div>;
  if (events.length === 0) return <div className="usage-dim">Nothing has happened in this space yet.</div>;
  return (
    <ul className="space-events">
      {events.map(e => (
        <li key={e.id}>
          <span className="space-event-at">{new Date(e.at).toLocaleString()}</span>
          <span className="space-event-who">{who(e)}</span>
          <span className="space-event-what">{actionLabel(e.action)}</span>
          <span className="space-event-path">{e.path ?? ''}{e.bytes != null ? ` (${formatBytes(e.bytes)})` : ''}</span>
        </li>
      ))}
    </ul>
  );
}
