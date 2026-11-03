import React, { useState } from 'react';
import { adminApi, type AdminInstanceDetail } from '../../services/adminApi';
import { Dialog } from '../../components/Dialog';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { fmtAgo } from './shared';
import {
  QUARANTINE_REASON_MAX,
  QUARANTINE_STEP_LABELS,
  QUARANTINE_STEP_SHORT,
  canQuarantine,
  quarantineConfirmed,
  quarantineNeedsRetry,
  quarantineOutcomeClass,
  quarantineSnapshotIds,
  quarantineStillConnected,
} from '../../utils/boxQuarantine';

function errorText(e: unknown): string {
  return (e as { response?: { data?: { error?: string } } }).response?.data?.error ?? (e as Error).message;
}

/**
 * The Fleet detail card's quarantine section: the action for a live
 * box, and for a quarantined one what each containment step did, a retry for
 * the ones that did not finish, and the terminate that ends it.
 */
export function BoxQuarantine({ box, now, onChanged }: { box: AdminInstanceDetail; now: number; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [confirmTerminate, setConfirmTerminate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const q = box.quarantine;
  const steps = q?.steps ?? null;

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr(null);
    try { await fn(); onChanged(); } catch (e) { setErr(errorText(e)); } finally { setBusy(false); }
  };

  return (
    <>
      <div className="dash-section-title" style={{ marginTop: 8 }}>quarantine</div>
      {q ? (
        <>
          <dl className="admin-quarantine-steps">
            <dt>quarantined</dt><dd>{fmtAgo(q.at, now)} by {q.by ?? 'unknown'} · was {q.fromStatus ?? '?'}</dd>
            <dt>reason</dt><dd>{q.reason ?? '—'}</dd>
            {QUARANTINE_STEP_LABELS.map(([step, label]) => {
              const r = steps?.find(s => s.step === step);
              return (
                <React.Fragment key={step}>
                  <dt title={label}>{QUARANTINE_STEP_SHORT[step]}</dt>
                  <dd title={r?.at}>
                    {r ? <><span className={quarantineOutcomeClass(r.outcome)}>{r.outcome}</span>{r.detail ? <span className="usage-dim"> · {r.detail}</span> : null}</>
                      : <span className="usage-dim">not recorded</span>}
                  </dd>
                </React.Fragment>
              );
            })}
          </dl>
          {box.status === 'quarantined' && box.kind === 'ec2' && box.ec2InstanceId && !q.running && quarantineStillConnected(steps) && (
            <div className="admin-bad">
              Not stopped yet: removing its security group rules refuses new connections only, so any already open are still up.
              Stop it from the EC2 console if the retry can&apos;t.
            </div>
          )}
          {box.status === 'quarantined' && (
            <div className="admin-quarantine-actions">
              {q.running && <span className="usage-dim">containment steps running…</span>}
              {quarantineNeedsRetry(box, steps, q.running) && (
                <button type="button" className="btn-ghost btn-tiny" disabled={busy}
                  title="Runs again only the steps that did not finish; snapshots already taken are kept"
                  onClick={() => void run(() => adminApi.quarantineBox(box.id, q.reason ?? 'retry'))}>
                  {busy ? 'Retrying…' : 'Retry unfinished steps'}
                </button>
              )}
              <button type="button" className="btn-ghost btn-tiny admin-bad" disabled={busy} onClick={() => setConfirmTerminate(true)}>
                Terminate…
              </button>
            </div>
          )}
        </>
      ) : canQuarantine(box) ? (
        <div className="admin-quarantine-actions">
          <button type="button" className="btn-ghost btn-tiny admin-bad" onClick={() => { setErr(null); setOpen(true); }}>
            Quarantine box…
          </button>
          <span className="usage-dim">cut it off and keep its disks for a forensic look</span>
        </div>
      ) : (
        <div className="usage-dim">not quarantined</div>
      )}
      {err && !open && <div className="error-banner">{err}<button type="button" onClick={() => setErr(null)}>×</button></div>}

      {open && (
        <QuarantineDialog
          box={box}
          busy={busy}
          error={err}
          onCancel={() => { if (!busy) setOpen(false); }}
          onConfirm={reason => void run(async () => { await adminApi.quarantineBox(box.id, reason); setOpen(false); })}
        />
      )}
      {confirmTerminate && (
        <ConfirmDialog
          message={<>
            Terminate <b>{box.name}</b>? This destroys the EC2 instance, its role and security group, and archives
            its {box.projects.active} live project{box.projects.active === 1 ? '' : 's'}.
            {quarantineSnapshotIds(steps).length > 0
              ? <> The forensic snapshots stay: <code className="confirm-code">{quarantineSnapshotIds(steps).join(' ')}</code></>
              : <> <b className="admin-bad">No snapshot was recorded</b>; once terminated, its disks are gone.</>}
          </>}
          confirmLabel="Terminate"
          onCancel={() => setConfirmTerminate(false)}
          onConfirm={() => { setConfirmTerminate(false); void run(() => adminApi.terminateQuarantinedBox(box.id)); }}
        />
      )}
    </>
  );
}

function QuarantineDialog({ box, busy, error, onCancel, onConfirm }: {
  box: AdminInstanceDetail;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  const [typed, setTyped] = useState('');
  const ready = quarantineConfirmed(box.name, typed, reason) && !busy;
  const ec2 = box.kind === 'ec2' && !!box.ec2InstanceId;
  return (
    <Dialog title={`Quarantine ${box.name}`} onClose={onCancel} closeDisabled={busy} className="admin-quarantine-dialog">
      <form onSubmit={e => { e.preventDefault(); if (ready) onConfirm(reason.trim()); }}>
        <div className="confirm-message">
          {box.owner ? <><b>{box.owner.unixUsername}</b>&apos;s box</> : 'This warm-pool box'} is taken out of service and kept as it is.
          Its owner can&apos;t start, stop, rename or terminate it; only an admin&apos;s terminate ends a quarantine.
          {ec2 ? ' In order:' : ' It is a self-managed box, so termag can only revoke its tokens: isolate the machine itself.'}
        </div>
        {ec2 && (
          <ol>
            {QUARANTINE_STEP_LABELS.map(([step, label]) => (
              <li key={step}>
                {label}
                {step === 'stop' && box.hibernationConfigured ? ' (hibernated, so its memory is written to the root volume the snapshot takes)' : ''}
                {step === 'snapshot' ? ' (tagged Retain=true, so the nightly prune keeps them)' : ''}
              </li>
            ))}
          </ol>
        )}
        <label htmlFor="quarantine-reason">Why (kept on the box row and the EC2 tags; the owner does not see it)</label>
        <textarea id="quarantine-reason" value={reason} maxLength={QUARANTINE_REASON_MAX} onChange={e => setReason(e.target.value)}
          placeholder="e.g. the scanner flags a credential stealer on this box" autoFocus />
        <label htmlFor="quarantine-confirm">Type <b>{box.name}</b> to confirm</label>
        <input id="quarantine-confirm" value={typed} onChange={e => setTyped(e.target.value)} autoComplete="off" spellCheck={false} />
        {error && <div className="error-banner">{error}</div>}
        <div className="confirm-actions" style={{ marginTop: 14 }}>
          <button type="button" className="confirm-btn confirm-btn-cancel" onClick={onCancel} disabled={busy}>Cancel</button>
          <button type="submit" className="confirm-btn confirm-btn-confirm" disabled={!ready}>{busy ? 'Quarantining…' : 'Quarantine'}</button>
        </div>
      </form>
    </Dialog>
  );
}
