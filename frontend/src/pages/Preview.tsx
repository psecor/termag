import React, { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { BrowserPane, type PaneCheckout } from '../components/BrowserPane';
import { previewSharesApi, type GuestShareView } from '../services/api';
import { MOBILE_MEDIA_QUERY } from '../mobile/redirect';
import { BROWSER_PANE_CLOSE } from '../utils/browserPaneInput';
import { safeAtPath } from '../utils/browserPaneConnection';

/** How long the page waits for a woken box to come up, and how often it looks. */
export const WAKE_WAIT_MS = 4 * 60 * 1000;
export const WAKE_POLL_MS = 5000;
/** Statuses a woken box can settle to without coming up: the page stops waiting. */
const WAKE_GAVE_UP = ['hibernated', 'stopped', 'terminated', 'failed'];

type Load =
  | { kind: 'loading' }
  | { kind: 'not-shared' }
  | { kind: 'failed'; message: string }
  | { kind: 'loaded'; view: GuestShareView };

function endsIn(iso: string, now: number): string {
  const ms = Date.parse(iso) - now;
  if (ms <= 0) return 'ended';
  const h = Math.round(ms / 3_600_000);
  if (h >= 48) return `ends in ${Math.round(h / 24)} days`;
  if (h >= 1) return `ends in ${h} hour${h === 1 ? '' : 's'}`;
  return `ends in ${Math.max(1, Math.round(ms / 60_000))} minutes`;
}

/**
 * A reviewer's page for a preview share: their own
 * browser on the owner's box, reaching only the shared app, and nothing else
 * of the project. Mounted outside the workspace and its gates (first run,
 * phone, simple UI), so a reviewer with no projects of their own, on any
 * device, lands here. The server decides what they may see; this page reads
 * no flags. Anyone the share isn't for gets the same "isn't shared with you".
 */
export default function Preview() {
  const { shareId = '' } = useParams();
  const [search] = useSearchParams();
  const at = safeAtPath(search.get('at'));
  const asGuest = search.get('as') === 'guest';
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [checkout, setCheckout] = useState<PaneCheckout | null>(null);
  const [asleep, setAsleep] = useState(false);
  const [asked, setAsked] = useState<string | null>(null);
  // A reviewer waking the box (4b): starting, then the pane dials again once it is up.
  const [waking, setWaking] = useState<{ phase: 'starting' | 'stuck' | 'refused'; message: string } | null>(null);
  const [paneKey, setPaneKey] = useState(0);
  const phone = typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(MOBILE_MEDIA_QUERY).matches;

  useEffect(() => {
    let gone = false;
    previewSharesApi.get(shareId).then(
      view => { if (!gone) setLoad({ kind: 'loaded', view }); },
      err => {
        if (gone) return;
        const status = (err as { response?: { status?: number } })?.response?.status;
        setLoad(status === 404 ? { kind: 'not-shared' } : { kind: 'failed', message: 'Could not load this preview. Try again in a moment.' });
      },
    );
    return () => { gone = true; };
  }, [shareId]);

  useEffect(() => {
    if (load.kind !== 'loaded') return;
    const before = document.title;
    document.title = `${load.view.owner.name}'s preview · ${load.view.project.name}`;
    return () => { document.title = before; };
  }, [load]);

  const card = (title: string, body?: React.ReactNode) => (
    <div className="preview-page preview-page--card">
      <div className="preview-card">
        <h1>{title}</h1>
        {body}
      </div>
    </div>
  );

  if (load.kind === 'loading') return <div className="loading-screen">Loading…</div>;
  if (load.kind === 'not-shared') return card("This preview isn't shared with you.", <p>Ask whoever sent the link to share it with your termag account.</p>);
  if (load.kind === 'failed') return card('Preview unavailable', <p>{load.message}</p>);
  const { view } = load;
  if (view.state !== 'active') return card(view.message ?? 'This preview has ended.', <p>{view.owner.name} can share {view.project.name} again from their workspace.</p>);
  if (phone) {
    return card('Open this preview on a desktop', (
      <p>A preview is a full browser on {view.owner.name}'s box, and needs a mouse and a keyboard. Open the same link on a laptop.</p>
    ));
  }

  // Asleep: read the share again, so the page knows whether this reviewer may wake it now.
  const refresh = async () => {
    try { setLoad({ kind: 'loaded', view: await previewSharesApi.get(shareId) }); } catch { /* keep what we have */ }
  };

  const wake = async () => {
    setWaking({ phase: 'starting', message: `Waking ${view.owner.name}'s box. That usually takes a minute or two…` });
    try {
      await previewSharesApi.wake(view.id);
    } catch (err) {
      const message = (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Could not wake the box.';
      setWaking({ phase: 'refused', message });
      return;
    }
    const until = Date.now() + WAKE_WAIT_MS;
    while (Date.now() < until) {
      await new Promise(r => setTimeout(r, WAKE_POLL_MS));
      const now = await previewSharesApi.get(view.id).catch(() => null);
      // A resume that didn't take settles back down: no use waiting out the clock.
      if (now && now.boxStatus && WAKE_GAVE_UP.includes(now.boxStatus)) {
        setLoad({ kind: 'loaded', view: now });
        setWaking({ phase: 'refused', message: now.canWake
          ? `${view.owner.name}'s box didn't come up and is asleep again. You can try waking it again.`
          : `${view.owner.name}'s box didn't come up. Ask ${view.owner.name} to start it.` });
        return;
      }
      if (now?.boxStatus === 'ready') {
        setWaking(null);
        setAsleep(false);
        setLoad({ kind: 'loaded', view: now });
        // The pane dials again; its attach checks the dev stack and says so if it isn't running.
        setPaneKey(k => k + 1);
        return;
      }
    }
    setWaking({ phase: 'stuck', message: `${view.owner.name}'s box is still starting. Try again in a minute.` });
  };

  const ask = async () => {
    setAsked('Asking…');
    try {
      const r = await previewSharesApi.askWake(view.id);
      setAsked(r.sent ? `Asked ${view.owner.name} on Slack. Try again once their box is up.` : `Couldn't reach ${view.owner.name} on Slack. Ask them directly to start their box.`);
    } catch (err) {
      const code = (err as { response?: { data?: { code?: string } } })?.response?.data?.code;
      setAsked(code === 'asked-recently' ? `${view.owner.name} was asked a few minutes ago.` : 'Could not send the request.');
    }
  };

  return (
    <div className="preview-page">
      <header className="preview-header">
        <div className="preview-header-title">
          <strong>{view.owner.name}'s preview</strong>
          <span className="usage-dim"> · {view.project.name} · {view.workstream}{asGuest ? ' · previewing as your guest' : ''}</span>
          {view.pr && (
            <span className="usage-dim"> · <a href={view.pr.url} target="_blank" rel="noreferrer">{view.pr.repo.split('/')[1]}#{view.pr.number}</a></span>
          )}
          {view.signInHint && <span className="preview-header-hint"> · sign in as <code>{view.signInHint}</code></span>}
        </div>
        <div className="preview-header-meta usage-dim">
          {checkout && (
            <span title={checkout.head}>
              {view.pr ? 'box' : checkout.branch || 'detached'} @ {checkout.head.slice(0, 8)}
              {checkout.dirty ? ` · ${checkout.dirty} uncommitted change${checkout.dirty === 1 ? '' : 's'} shown live` : ''}
              {' · '}
            </span>
          )}
          {/* A PR's preview says whether the box shows the PR's head, or something before or after it. */}
          {view.pr?.headOid && (
            <span title={view.pr.headOid} className={checkout && !view.pr.headOid.startsWith(checkout.head) && !checkout.head.startsWith(view.pr.headOid) ? 'preview-header-differs' : undefined}>
              PR head @ {view.pr.headOid.slice(0, 8)}{' · '}
            </span>
          )}
          {endsIn(view.expiresAt, Date.now())}
        </div>
      </header>
      {asleep ? (
        <div className="preview-asleep">
          {view.asOwner
            ? <p>Your box is asleep, so the preview can't open. Start it from termag's Boxes list, then try again.</p>
            : view.canWake
              ? <p>{view.owner.name}'s box went to sleep after a while unused. You can wake it for this preview; {view.owner.name} is told.</p>
              : <p>{view.owner.name}'s box is asleep, so the preview can't open. A reviewer can't wake it.</p>}
          <div className="preview-asleep-actions">
            {!view.asOwner && view.canWake && (
              <button type="button" className="btn-primary" onClick={() => { void wake(); }} disabled={waking?.phase === 'starting'}>
                {waking?.phase === 'starting' ? 'Waking…' : 'Wake the box'}
              </button>
            )}
            {!view.asOwner && !view.canWake && <button type="button" className="btn-primary" onClick={ask} disabled={asked === 'Asking…'}>Ask {view.owner.name} to wake it</button>}
            <button type="button" disabled={waking?.phase === 'starting'} onClick={() => { setWaking(null); setAsleep(false); setPaneKey(k => k + 1); }}>Try again</button>
          </div>
          {waking && <p className={waking.phase === 'refused' ? 'error-text' : 'usage-dim'} role="status">{waking.message}</p>}
          {asked && <p className="usage-dim">{asked}</p>}
        </div>
      ) : (
        <div className="preview-pane">
          <BrowserPane
            key={paneKey}
            share={{ shareId: view.id, at, asGuest }}
            url="about:blank"
            onUrlChange={() => {}}
            onCheckout={setCheckout}
            onClosed={(code) => { if (code === BROWSER_PANE_CLOSE.PARKED) { setAsleep(true); void refresh(); } }}
          />
        </div>
      )}
    </div>
  );
}
