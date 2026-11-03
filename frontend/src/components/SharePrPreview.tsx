import React, { useState } from 'react';
import { FLAGS, useFlag } from '../flags';
import { previewShareLink, previewSharesApi, type LinkShareMade, type PrLaneId, type PrRow, type PrWorkstreamLink } from '../services/api';
import { apiErrorText } from '../utils/prPipeline';
import { checkoutLabel } from '../utils/checkoutLabel';

/** The lanes an open PR of the viewer's own sits in: the only ones a preview link is offered on. */
const OWN_OPEN_LANES: PrLaneId[] = ['in_progress', 'checks', 'needs_approval', 'ready_to_merge'];

/** Whether a row is a PR "Share preview" is offered on: an open PR of the viewer's own, with a workstream. */
export function offersPrShare(row: PrRow): row is PrRow & { workstream: PrWorkstreamLink; repo: string; number: number } {
  return row.kind === 'pr' && row.workstream != null && row.repo != null && row.number != null && OWN_OPEN_LANES.includes(row.lane);
}

/**
 * The PR overlay's "Share preview": a link any signed-in termag user can open, to their own browser on
 * the owner's box kept to this PR's app, posted on the PR as a comment and
 * copied here. The server checks the PR on GitHub and decides; this only
 * offers it on a PR of the viewer's own with a workstream. A draft is offered
 * too: whether its repository allows drafts is the server's to say, and its
 * refusal is shown. "Stop sharing" ends it (the comment loses the link).
 */
export function SharePrPreview({ row, onChanged, ended }: {
  row: PrRow;
  /** It made or ended a share. */
  onChanged?: () => void;
  /** Shares ended elsewhere (the side panel's share list): one it made is offered again. */
  ended?: ReadonlySet<string>;
}) {
  const sharing = useFlag(FLAGS.previewShare, false);
  const prLinks = useFlag(FLAGS.prLinkShares, false);
  const [busy, setBusy] = useState(false);
  const [made, setMade] = useState<LinkShareMade | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!sharing || !prLinks) return null;
  if (!offersPrShare(row)) return null;
  const ws = row.workstream;
  const repo = row.repo;
  const number = row.number;
  // Ended from the share list: its note is about a share that is gone, too.
  const endedElsewhere = made != null && ended?.has(made.id) === true;
  const live = endedElsewhere ? null : made;

  const copy = async (m: LinkShareMade) => {
    try { await navigator.clipboard.writeText(previewShareLink(m.id, null, m.linkPath)); return true; } catch { return false; }
  };

  const share = async () => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const m = await previewSharesApi.createLink(ws.projectId, { workstream: ws.workstream, repo, number });
      setMade(m);
      onChanged?.();
      const copied = await copy(m);
      const c = m.comment;
      const posted = c.state === 'posted' ? 'Its link is posted on the PR' : c.state === 'kept' ? 'Its link is on the PR' : c.state === 'posting' ? 'Its link is being posted on the PR' : null;
      setNote([
        m.existing ? 'Already shared.' : 'Shared.',
        posted ? `${posted}${copied ? ' and copied' : ''}.` : copied ? 'Link copied.' : null,
        c.state === 'failed' ? c.error : null,
      ].filter(Boolean).join(' '));
    } catch (err) {
      setError(apiErrorText(err, 'Could not share the preview.'));
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    if (!live) return;
    setBusy(true);
    setError(null);
    try {
      await previewSharesApi.revoke(ws.projectId, live.id);
      setMade(null);
      onChanged?.();
      setNote('Stopped sharing. The comment on the PR no longer carries the link.');
    } catch (err) {
      setError(apiErrorText(err, 'Could not stop sharing.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="prs-share-preview">
      {!live ? (
        <button type="button" className="btn-ghost btn-tiny" disabled={busy} onClick={() => { void share(); }}
          title="A link anyone signed in to termag can open: their own browser on your box, kept to this PR's app. Posted on the PR; ends when it merges or closes.">
          {busy ? 'Sharing…' : 'Share preview'}
        </button>
      ) : (
        <>
          {live.checkoutDir && <span className="usage-dim prs-share-note" title={live.checkoutDir}>from {checkoutLabel(live.checkoutDir)}</span>}
          <button type="button" className="btn-ghost btn-tiny" disabled={busy} onClick={() => { void copy(live).then(ok => setNote(ok ? 'Link copied.' : 'Could not copy the link.')); }}>Copy link</button>
          <button type="button" className="btn-ghost btn-tiny" disabled={busy} onClick={() => { void stop(); }}>Stop sharing</button>
        </>
      )}
      {note && !endedElsewhere && <span className="usage-dim prs-share-note" role="status">{note}</span>}
      {error && <span className="error-text prs-share-note" role="alert">{error}</span>}
    </span>
  );
}
