import React, { useEffect, useState } from 'react';
import { FLAGS, useFlag } from '../flags';
import { previewSharesApi, type PreviewSettingsView } from '../services/api';

/**
 * A project's PR preview settings, in the share dialog: share the PRs its owner opens automatically, only those
 * changing a path under the filter, and what reviewers sign in to the app
 * with. A PR labelled `no-preview` is never shared automatically. The server
 * checks and saves; this only edits.
 */
export function PrPreviewSettings({ projectId }: { projectId: string }) {
  const prLinks = useFlag(FLAGS.prLinkShares, false);
  const [saved, setSaved] = useState<PreviewSettingsView | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [filter, setFilter] = useState('');
  const [hint, setHint] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!prLinks) return;
    let gone = false;
    previewSharesApi.settings(projectId).then(s => {
      if (gone) return;
      setSaved(s);
      setEnabled(s.prLinksEnabled);
      setFilter(s.pathFilter.join(' '));
      setHint(s.reviewerAccountHint ?? '');
    }, () => { if (!gone) setError('Could not load the PR preview settings.'); });
    return () => { gone = true; };
  }, [projectId, prLinks]);

  if (!prLinks) return null;

  const dirty = saved !== null && (enabled !== saved.prLinksEnabled || filter.trim().split(/[\s,]+/).filter(Boolean).join(' ') !== saved.pathFilter.join(' ')
    || (hint.trim() || null) !== saved.reviewerAccountHint);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const s = await previewSharesApi.saveSettings(projectId, { prLinksEnabled: enabled, pathFilter: filter, reviewerAccountHint: hint });
      setSaved(s);
      setFilter(s.pathFilter.join(' '));
      setHint(s.reviewerAccountHint ?? '');
      setNote('Saved.');
    } catch (err) {
      setError((err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Could not save the settings.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="pr-preview-settings" onSubmit={save} aria-label="PR previews">
      <div className="pr-preview-settings-title">PR previews for this project</div>
      <label className="pr-preview-settings-check">
        <input type="checkbox" checked={enabled} disabled={saved === null} onChange={e => setEnabled(e.target.checked)} />
        Share a preview of each PR I open, with a link on the PR any signed-in termag user can open
      </label>
      <label>
        <span>Only PRs changing a path under</span>
        <input type="text" value={filter} disabled={saved === null} onChange={e => setFilter(e.target.value)} placeholder="any path (e.g. static/ internal/api)" />
      </label>
      <label>
        <span>Reviewers sign in to the app as</span>
        <input type="text" value={hint} disabled={saved === null} onChange={e => setHint(e.target.value)} placeholder="the app's seeded account (reviewer@example.com / example-password)" />
      </label>
      <div className="pr-preview-settings-actions">
        <span className="usage-dim">A PR labelled <code>no-preview</code> is never shared on its own. Share any PR by hand from the PR overlay.</span>
        <button type="submit" disabled={busy || !dirty}>{busy ? 'Saving…' : 'Save'}</button>
      </div>
      {note && <div className="usage-dim" role="status">{note}</div>}
      {error && <div className="share-dialog-error" role="alert">{error}</div>}
    </form>
  );
}
