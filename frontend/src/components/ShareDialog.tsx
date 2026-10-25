import React, { useCallback, useEffect, useState } from 'react';
import { Dialog } from './Dialog';
import { PersonPicker } from './PersonPicker';
import { PrPreviewSettings } from './PrPreviewSettings';
import { browserStorage, rememberPerson } from '../utils/recentPeople';
import { previewShareLink, previewSharesApi, type PreviewShareView } from '../services/api';

interface Props {
  projectId: string;
  workstream: string;
  /** browser-pane-preview-share-ttl-hours: the lifetime the dialog preselects. */
  defaultTtlHours: number;
  /** The page the owner's pane shows: the links the dialog copies open there. */
  atPath?: string | null;
  onClose: () => void;
}

const LIFETIMES = [72, 168];

function hoursLabel(h: number): string {
  if (h % 24 === 0) return `${h / 24} day${h === 24 ? '' : 's'}`;
  return `${h} hour${h === 1 ? '' : 's'}`;
}

function relative(iso: string | null, now: number): string {
  if (!iso) return 'never';
  const ms = Date.parse(iso) - now;
  const abs = Math.abs(ms);
  const unit = abs >= 86_400_000 ? [86_400_000, 'day'] as const : abs >= 3_600_000 ? [3_600_000, 'hour'] as const : [60_000, 'minute'] as const;
  const n = Math.max(1, Math.round(abs / unit[0]));
  const text = `${n} ${unit[1]}${n === 1 ? '' : 's'}`;
  return ms >= 0 ? `in ${text}` : `${text} ago`;
}

function errorText(err: unknown): string {
  const data = (err as { response?: { data?: { error?: string } } })?.response?.data;
  return data?.error ?? (err instanceof Error ? err.message : 'Something went wrong.');
}

/**
 * Share this workstream's preview with a named termag user.
 * They get their own browser on this box, reaching
 * only the shared app, and nothing else of the project: no terminals, agent
 * or files. The dialog makes a share, and lists this workstream's shares with
 * who is looking now, what their browser was refused, and their links.
 */
export function ShareDialog({ projectId, workstream, defaultTtlHours, atPath = null, onClose }: Props) {
  const [email, setEmail] = useState('');
  // The name of the person picked from the suggestions, kept with them in this browser's recent list.
  const [pickedName, setPickedName] = useState<string | undefined>();
  const [ttl, setTtl] = useState(defaultTtlHours);
  const [manual, setManual] = useState(false);
  const [origins, setOrigins] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shares, setShares] = useState<PreviewShareView[] | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  // Shared with them already: their share was renewed, same link.
  const [notice, setNotice] = useState<string | null>(null);
  const now = Date.now();

  const reload = useCallback(() => {
    previewSharesApi.list(projectId).then(all => setShares(all.filter(s => s.workstream === workstream)), () => setShares([]));
  }, [projectId, workstream]);
  useEffect(() => { reload(); }, [reload]);

  const copy = async (shareId: string, linkPath?: string | null) => {
    try {
      await navigator.clipboard.writeText(previewShareLink(shareId, atPath, linkPath));
      setCopied(shareId);
      setTimeout(() => setCopied(c => (c === shareId ? null : c)), 2000);
    } catch { setError('Could not copy the link.'); }
  };

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const recipe = manual
        ? { kind: 'manual' as const, origins: origins.split(/[\s,]+/).map(o => o.trim()).filter(Boolean) }
        : undefined;
      const made = await previewSharesApi.create(projectId, { email: email.trim(), workstream, ttlHours: ttl, ...(recipe ? { recipe } : {}) });
      rememberPerson(browserStorage(), { email: email.trim(), displayName: pickedName });
      setEmail('');
      setPickedName(undefined);
      if (made.renewed) setNotice(`Already shared with ${email.trim()}: their share is renewed, same link (copied).`);
      await copy(made.id);
      reload();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try { await fn(); } catch (err) { setError(errorText(err)); }
    reload();
  };

  const live = (shares ?? []).filter(s => !s.endedAt && Date.parse(s.expiresAt) > now);
  const lifetimes = [...new Set([defaultTtlHours, ...LIFETIMES])].sort((a, b) => a - b);

  return (
    <Dialog title={`Share the preview of ${workstream}`} onClose={onClose} className="share-dialog" closeDisabled={busy}>
      <p className="share-dialog-lede">
        They get their own browser on this box, kept to the app you share, and nothing else of the project: no terminals, no agent, no files.
        What they do in the app lands in your dev stack.
      </p>
      <form className="share-dialog-form" onSubmit={create}>
        <label>
          <span>Their termag email</span>
          <PersonPicker required autoFocus value={email} onChange={(next, name) => { setEmail(next); setPickedName(name); }} placeholder="name or name@example.com" />
        </label>
        <label>
          <span>For</span>
          <select value={ttl} onChange={e => setTtl(Number(e.target.value))}>
            {lifetimes.map(h => <option key={h} value={h}>{hoursLabel(h)}</option>)}
          </select>
        </label>
        <fieldset className="share-dialog-recipe">
          <legend>What they can reach</legend>
          <label><input type="radio" checked={!manual} onChange={() => setManual(false)} /> This workstream's webapp dev stack</label>
          <label><input type="radio" checked={manual} onChange={() => setManual(true)} /> These addresses on this box</label>
          {manual && (
            <textarea
              aria-label="Addresses"
              rows={2}
              value={origins}
              onChange={e => setOrigins(e.target.value)}
              placeholder="127.0.0.1:3000 127.0.0.1:3001"
            />
          )}
        </fieldset>
        <div className="share-dialog-actions">
          {atPath && <span className="usage-dim share-dialog-at" title={atPath}>Links open at {atPath}</span>}
          <button type="submit" className="btn-primary" disabled={busy || !email.trim()}>{busy ? 'Sharing…' : 'Share and copy link'}</button>
        </div>
      </form>
      {error && <div className="share-dialog-error" role="alert">{error}</div>}
      {notice && <div className="share-dialog-notice usage-dim" role="status">{notice}</div>}
      <div className="share-dialog-list" aria-label="Shares">
        {shares === null && <div className="usage-dim">Loading…</div>}
        {shares !== null && live.length === 0 && <div className="usage-dim">Not shared with anyone yet.</div>}
        {live.map(s => (
          <div key={s.id} className="share-dialog-row">
            <div className="share-dialog-who">
              {s.audience === 'link' && s.pr ? (
                <>
                  <strong>Link on <a href={s.pr.url} target="_blank" rel="noreferrer">{s.pr.repo.split('/')[1]}#{s.pr.number}</a></strong>
                  <span className="usage-dim"> anyone signed in to termag, until it merges or closes</span>
                </>
              ) : (
                <>
                  <strong>{s.grantee?.name ?? 'someone'}</strong>
                  <span className="usage-dim"> {s.grantee?.email}</span>
                </>
              )}
              <div className="usage-dim">
                {s.liveViewers > 0 ? `looking now · ` : ''}opened {relative(s.lastOpenedAt, now)} · ends {relative(s.expiresAt, now)}
              </div>
              {s.audience === 'link' && (s.viewers ?? []).length > 0 && (
                <ul className="share-dialog-viewers" aria-label="Who opened it">
                  {(s.viewers ?? []).map(v => (
                    <li key={v.userId}>
                      <span title={v.email}>{v.name}</span>
                      <span className="usage-dim"> {v.revokedAt ? 'removed' : `opened ${relative(v.lastOpenedAt, now)}`}</span>
                      {!v.revokedAt && (
                        <button type="button" className="btn-tiny" onClick={() => act(() => previewSharesApi.revokeViewer(projectId, s.id, v.userId))}>Remove</button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {s.blockedOrigins.length > 0 && (
                <div className="share-dialog-blocked">Their browser was refused {s.blockedOrigins.join(', ')}: not part of this share.</div>
              )}
            </div>
            <div className="share-dialog-row-actions">
              <button type="button" onClick={() => copy(s.id, s.linkPath)}>{copied === s.id ? 'Copied' : 'Copy link'}</button>
              <button type="button" onClick={() => window.open(`/termag/preview/${s.id}?as=guest`, '_blank', 'noopener')}>Preview as guest</button>
              {/* Extending sets the end to the chosen lifetime from now: offered only when that is later. A PR's link lasts as its PR does. */}
              {s.audience !== 'link' && now + ttl * 3_600_000 > Date.parse(s.expiresAt) && (
                <button type="button" onClick={() => act(() => previewSharesApi.extend(projectId, s.id, ttl))}>Extend to {hoursLabel(ttl)} from now</button>
              )}
              <button type="button" className="btn-danger" onClick={() => act(() => previewSharesApi.revoke(projectId, s.id))}>Stop sharing</button>
            </div>
          </div>
        ))}
      </div>
      <PrPreviewSettings projectId={projectId} />
    </Dialog>
  );
}
