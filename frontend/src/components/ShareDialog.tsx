import React, { useCallback, useEffect, useState } from 'react';
import { Dialog } from './Dialog';
import { PersonPicker } from './PersonPicker';
import { PrPreviewSettings } from './PrPreviewSettings';
import { browserStorage, rememberPerson } from '../utils/recentPeople';
import { checkoutLabel } from '../utils/checkoutLabel';
import { previewShareLink, previewSharesApi, type PreviewShareView, type PreviewStackCheck } from '../services/api';
import { FLAGS, useFlag } from '../flags';
import { useProjects } from '../contexts/ProjectContext';
import { useEnvironmentSelection } from '../hooks/useEnvironments';
import { Label, Radio, RadioGroup } from '@launchpad-ui/components';
import { LP_THEME } from '../launchpad/theme';
import { PreviewLinksPanel } from '../previewLinks/PreviewLinksPanel';

interface ShareProps {
  projectId: string;
  workstream: string;
  /** browser-pane-preview-share-ttl-hours: the lifetime the dialog preselects. */
  defaultTtlHours: number;
  /** The page the owner's pane shows: the links the dialog copies open there. */
  atPath?: string | null;
  /** Switch the workspace to another of the project's workstreams: offered when its dev stack is the one running. */
  onSwitchWorkstream?: (workstream: string) => void;
}

interface Props extends ShareProps {
  onClose: () => void;
}

interface SharePreviewProps extends ShareProps {
  /** Focus the email field on mount: the dialog does; the side panel's tab doesn't, since a page load can restore it. */
  autoFocus?: boolean;
  /** A share is being made: the dialog can't be closed meanwhile. */
  onBusyChange?: (busy: boolean) => void;
  /** Where a PR is shared by hand, for the PR preview settings. */
  byHand?: string;
  /** Changing it lists the shares again: one was made or ended outside (the side panel's PR rows). */
  reloadKey?: number;
  /** A share was ended here (Stop sharing). */
  onEnded?: (shareId: string) => void;
  /** Shown above the PR preview settings: the side panel's PRs to share by hand. */
  children?: React.ReactNode;
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

/** The full UI's share dialog, from "Share…" on the browser dock: SharePreview in a modal. */
export function ShareDialog({ onClose, ...share }: Props) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog title={`Share the preview of ${share.workstream}`} onClose={onClose} className="share-dialog" closeDisabled={busy}>
      <SharePreview {...share} autoFocus onBusyChange={setBusy} />
    </Dialog>
  );
}

type Delivery = 'termag' | 'browser';

/**
 * How the people it's shared with open the preview: in termag, in a browser
 * of their own on this box (the preview share below); or, with
 * preview-links-enabled, in their own browser at the app's own address (a
 * preview link, previewLinks/). The flag only hides the choice: the server
 * refuses a publish while it's off.
 */
export function SharePreview(props: SharePreviewProps) {
  const linksOn = useFlag(FLAGS.previewLinks, false);
  const [delivery, setDelivery] = useState<Delivery>('termag');
  const browser = linksOn && delivery === 'browser';
  // Once opened, each delivery stays mounted and is only hidden: a link's
  // one-time share URL and a share in flight survive a switch (Bugbot, #1485).
  const [linksOpened, setLinksOpened] = useState(false);
  useEffect(() => { if (browser) setLinksOpened(true); }, [browser]);
  // Either delivery mid-request keeps the dialog open: a link's one-time URL comes back only in its publish's answer (Devin, #1485).
  const [termagBusy, setTermagBusy] = useState(false);
  const [linkBusy, setLinkBusy] = useState(false);
  const { onBusyChange } = props;
  useEffect(() => { onBusyChange?.(termagBusy || linkBusy); }, [termagBusy, linkBusy, onBusyChange]);
  return (
    <>
      {linksOn && (
        <RadioGroup className={`${LP_THEME} share-delivery`} value={delivery} onChange={v => setDelivery(v as Delivery)}>
          <Label>Where they open it</Label>
          <div className="share-delivery-choices">
            <Radio value="termag">In termag</Radio>
            <Radio value="browser">In your browser</Radio>
          </div>
        </RadioGroup>
      )}
      {(browser || linksOpened) && linksOn && (
        // Keyed: another project or workstream ("Share X instead") starts a fresh form, never showing the last one's key (Bugbot, #1485).
        <div hidden={!browser}><PreviewLinksPanel key={`${props.projectId}:${props.workstream}`} projectId={props.projectId} workstream={props.workstream} onBusyChange={setLinkBusy} /></div>
      )}
      <div hidden={browser}><ShareInTermag {...props} autoFocus={props.autoFocus && !browser} onBusyChange={setTermagBusy} /></div>
    </>
  );
}

/**
 * Share this workstream's preview with a named termag user,
 * or, with nobody named and open links on, by a
 * link anyone signed in to termag can open. They get their own browser on
 * this box, reaching only the shared app, and nothing else of the project:
 * no terminals, agent or files. It makes a share, and lists this
 * workstream's shares with who is looking now, what their browser was
 * refused, and their links. The full UI shows it in ShareDialog; the simple
 * UI in its side panel's Share tab.
 */
function ShareInTermag({ projectId, workstream, defaultTtlHours, atPath = null, autoFocus = false, onBusyChange, byHand, reloadKey, onEnded, onSwitchWorkstream, children }: SharePreviewProps) {
  const [email, setEmail] = useState('');
  // The name of the person picked from the suggestions, kept with them in this browser's recent list.
  const [pickedName, setPickedName] = useState<string | undefined>();
  const [ttl, setTtl] = useState(defaultTtlHours);
  // What they reach: the workstream's webapp dev stack, the app its environment file runs (its first port), or addresses typed here.
  const [reach, setReach] = useState<'stack' | 'repo' | 'manual'>('stack');
  const manual = reach === 'manual';
  // The port "This environment's app" opens: the first of the environment file's (the box's last report).
  const { projects } = useProjects();
  // Project.environmentStatus is the main checkout's app (the claim's chain): only the main workstream shares it.
  // Another workstream's share would bind main's listeners and be refused at attach (Bugbot, #998).
  // Off (environment-selection-enabled), no environment choice is offered, this one included.
  const environmentsOn = useEnvironmentSelection();
  const firstPort = environmentsOn && workstream === 'main' ? projects.find(p => p.id === projectId)?.environmentStatus?.ports?.[0] ?? null : null;
  const [origins, setOrigins] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shares, setShares] = useState<PreviewShareView[] | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  // Shared with them already: their share was renewed, same link.
  const [notice, setNotice] = useState<string | null>(null);
  const now = Date.now();
  // Nobody named: an open link, for anyone signed in to termag who opens it.
  const named = email.trim() !== '';

  const reload = useCallback(() => {
    previewSharesApi.list(projectId).then(all => setShares(all.filter(s => s.workstream === workstream)), () => setShares([]));
  }, [projectId, workstream]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { reload(); }, [reload, reloadKey]);
  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);
  // Unmounted mid-share (the flag went off, the dialog's project changed): don't leave the dialog locked.
  useEffect(() => () => onBusyChange?.(false), [onBusyChange]);

  // A share is tied to this workstream: the box says now whether a reviewer
  // of its dev stack would get in, or whose stack would refuse them.
  const [stack, setStack] = useState<PreviewStackCheck | null>(null);
  useEffect(() => {
    setStack(null);
    if (manual) return;
    let current = true;
    previewSharesApi.stackCheck(projectId, workstream).then(r => { if (current) setStack(r); }, () => {});
    return () => { current = false; };
  }, [projectId, workstream, manual, reloadKey]);

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
        : reach === 'repo' ? { kind: 'repo' as const } : undefined;
      const made = await previewSharesApi.create(projectId, { ...(named ? { email: email.trim() } : { audience: 'link' as const }), workstream, ttlHours: ttl, ...(recipe ? { recipe } : {}) });
      if (named) rememberPerson(browserStorage(), { email: email.trim(), displayName: pickedName });
      setEmail('');
      setPickedName(undefined);
      if (made.renewed) setNotice(named ? `Already shared with ${email.trim()}: their share is renewed, same link (copied).` : 'Already shared by link: it is renewed, same link (copied).');
      await copy(made.id, made.linkPath);
      reload();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const act = async (fn: () => Promise<unknown>, after?: () => void) => {
    setError(null);
    try { await fn(); after?.(); } catch (err) { setError(errorText(err)); }
    reload();
  };

  const live = (shares ?? []).filter(s => !s.endedAt && Date.parse(s.expiresAt) > now);
  const lifetimes = [...new Set([defaultTtlHours, ...LIFETIMES])].sort((a, b) => a - b);

  return (
    <>
      <p className="share-dialog-lede">
        They get their own browser on this box, kept to the app you share, and nothing else of the project: no terminals, no agent, no files.
        What they do in the app lands in your dev stack.
      </p>
      <form className="share-dialog-form" onSubmit={create}>
        <label>
          <span>Their termag email</span>
          <PersonPicker autoFocus={autoFocus} value={email} onChange={(next, name) => { setEmail(next); setPickedName(name); }} placeholder="name or name@example.com" />
          <span className="usage-dim">Leave it empty for a link anyone signed in to termag can open.</span>
        </label>
        <label>
          <span>For</span>
          <select value={ttl} onChange={e => setTtl(Number(e.target.value))}>
            {lifetimes.map(h => <option key={h} value={h}>{hoursLabel(h)}</option>)}
          </select>
        </label>
        <fieldset className="share-dialog-recipe">
          <legend>What they can reach</legend>
          <label><input type="radio" checked={reach === 'stack'} onChange={() => setReach('stack')} /> This workstream's webapp dev stack</label>
          {/* Only with a port to open: a project with no environment (or an older agent) would land the guest on an error (#998). */}
          {firstPort && (
            <label>
              <input type="radio" checked={reach === 'repo'} onChange={() => setReach('repo')} /> This environment's app
              <span className="usage-dim"> · {firstPort.name} · {firstPort.port}</span>
            </label>
          )}
          <label><input type="radio" checked={manual} onChange={() => setReach('manual')} /> These addresses on this box</label>
          {manual && (
            <textarea
              aria-label="Addresses"
              rows={2}
              value={origins}
              onChange={e => setOrigins(e.target.value)}
              placeholder="127.0.0.1:3000 127.0.0.1:3001"
            />
          )}
          {/* The webapp stack's check: nothing to say for the environment's app or typed addresses. */}
          {reach === 'stack' && stack?.checked && !stack.ok && (
            <div className="share-dialog-stack" role="status">
              {stack.message}
              {stack.holder?.workstream && onSwitchWorkstream && (
                <button type="button" className="btn-tiny" onClick={() => onSwitchWorkstream(stack.holder!.workstream!)}>Share {stack.holder.workstream} instead</button>
              )}
            </div>
          )}
        </fieldset>
        <div className="share-dialog-actions">
          {atPath && <span className="usage-dim share-dialog-at" title={atPath}>Links open at {atPath}</span>}
          <button type="submit" className="btn-primary" disabled={busy}>
            {busy ? 'Sharing…' : named ? 'Share and copy link' : 'Share with anyone and copy link'}
          </button>
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
                  {s.checkoutDir && <div className="usage-dim" title={s.checkoutDir}>from {checkoutLabel(s.checkoutDir)}</div>}
                </>
              ) : s.audience === 'link' ? (
                <>
                  <strong>Open link</strong>
                  <span className="usage-dim"> anyone signed in to termag who opens it</span>
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
              {s.lastRefusal && (
                <div className="share-dialog-blocked">
                  Refused {relative(s.lastRefusal.at, now)}: “{s.lastRefusal.message}”
                  {s.lastRefusal.holder && <> The stack running was started from <span title={s.lastRefusal.holder}>{checkoutLabel(s.lastRefusal.holder)}</span>.</>}
                </div>
              )}
            </div>
            <div className="share-dialog-row-actions">
              <button type="button" onClick={() => copy(s.id, s.linkPath)}>{copied === s.id ? 'Copied' : 'Copy link'}</button>
              <button type="button" onClick={() => window.open(`/termag/preview/${s.id}?as=guest`, '_blank', 'noopener')}>Preview as guest</button>
              {/* Extending sets the end to the chosen lifetime from now: offered only when that is later. A PR's link lasts as its PR does. */}
              {!(s.audience === 'link' && s.pr) && now + ttl * 3_600_000 > Date.parse(s.expiresAt) && (
                <button type="button" onClick={() => act(() => previewSharesApi.extend(projectId, s.id, ttl))}>Extend to {hoursLabel(ttl)} from now</button>
              )}
              <button type="button" className="btn-danger" onClick={() => act(() => previewSharesApi.revoke(projectId, s.id), () => onEnded?.(s.id))}>Stop sharing</button>
            </div>
          </div>
        ))}
      </div>
      {children}
      <PrPreviewSettings projectId={projectId} byHand={byHand} />
    </>
  );
}
