import React, { useCallback, useEffect, useState } from 'react';
import { adminApi, type BoxDisk, type BoxGrow } from '../../services/adminApi';
import { fmtAgo } from './shared';

/** The root volume in one line: id, size, type and an EBS modification still under way. */
export function boxDiskSummary(volume: BoxDisk['volume']): string {
  if (!volume) return 'no EBS volume (not an EC2 box termag runs)';
  if ('error' in volume) return `could not read the volume: ${volume.error}`;
  const m = volume.modification;
  const running = m && m.state !== 'completed' && m.state !== 'failed'
    ? ` · EBS ${m.state}${m.progress != null ? ` ${m.progress}%` : ''}${m.targetSizeGb ? ` → ${m.targetSizeGb} GB` : ''}`
    : '';
  return `${volume.volumeId} · ${volume.sizeGb} GB${volume.volumeType ? ` ${volume.volumeType}` : ''}${running}`;
}

/** The last grow in one line, or null when this orchestrator has run none for the box. */
export function boxGrowSummary(grow: BoxGrow | null, now: number): string | null {
  if (!grow) return null;
  const step = grow.state === 'modifying' ? 'EBS modifying' : grow.state === 'filesystem' ? 'growing the file system' : grow.state;
  return `${grow.fromGb} → ${grow.toGb} GB by ${grow.by} ${fmtAgo(grow.startedAt, now)} · ${step}${grow.detail ? ` · ${grow.detail}` : ''}`;
}

type Volume = Exclude<BoxDisk['volume'], { error: string } | null>;
/** EBS allows one modification per volume every six hours. */
const MODIFY_COOLDOWN_MS = 6 * 3_600_000;

/**
 * The size the field starts at: twice the current size, which is what disk-full asks have wanted so far,
 * within EBS's ceiling. But when the volume already went to its size in the last six hours (a grow whose
 * file system step failed, or one an orchestrator restart cut off), the current size: EBS would refuse
 * another modification, and the same size re-runs only the file system step.
 */
export function defaultGrowGb(volume: Volume, grow: BoxGrow | null, maxGb: number, now: number): number {
  const m = volume.modification;
  const justModified = m != null && m.state !== 'failed' && m.targetSizeGb === volume.sizeGb
    && m.startedAt != null && now - Date.parse(m.startedAt) < MODIFY_COOLDOWN_MS;
  if (justModified || (grow?.state === 'failed' && grow.toGb === volume.sizeGb)) return volume.sizeGb;
  return Math.min(maxGb, volume.sizeGb * 2);
}

const growRunning = (g: BoxGrow | null) => g?.state === 'modifying' || g?.state === 'filesystem';

export function AdminBoxDisk({ boxId, now }: { boxId: string; now: number }) {
  const [disk, setDisk] = useState<BoxDisk | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [sizeGb, setSizeGb] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setDisk(await adminApi.boxDisk(boxId)); setLoadErr(null); } catch (e) { setLoadErr((e as Error).message); }
  }, [boxId]);
  useEffect(() => { setDisk(null); setSizeGb(''); setErr(null); void load(); }, [load]);
  // Poll only while a grow runs, so its steps show without a reload.
  useEffect(() => {
    if (!growRunning(disk?.grow ?? null)) return;
    const t = setInterval(() => void load(), 5_000);
    return () => clearInterval(t);
  }, [disk?.grow, load]);

  if (!disk) return <span className="usage-dim">{loadErr ? `could not load: ${loadErr}` : 'loading…'}</span>;
  const volume = disk.volume && !('error' in disk.volume) ? disk.volume : null;
  const grow = boxGrowSummary(disk.grow, now);
  const fallback = volume ? defaultGrowGb(volume, disk.grow, disk.maxGb, now) : NaN;
  const target = sizeGb.trim() === '' ? fallback : parseInt(sizeGb, 10);

  const submit = async () => {
    if (!volume || !Number.isInteger(target)) return;
    const question = target === volume.sizeGb
      ? `Grow the file system on ${volume.volumeId} into its ${target} GB? The volume is already that size, so EBS isn't asked again.`
      : `Grow ${volume.volumeId} from ${volume.sizeGb} GB to ${target} GB?\n\nEBS volumes can't shrink back, and a volume can be modified once every six hours.`;
    if (!window.confirm(question)) return;
    setBusy(true); setErr(null);
    try { await adminApi.growBoxDisk(boxId, target); setSizeGb(''); await load(); }
    catch (e) { setErr((e as { response?: { data?: { error?: string } } }).response?.data?.error ?? (e as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <div>
      {/* The volume id is code; the rest of the line is prose. */}
      <div>{volume ? <><span className="admin-mono">{volume.volumeId}</span>{boxDiskSummary(volume).slice(volume.volumeId.length)}</> : boxDiskSummary(disk.volume)}</div>
      {grow && <div className={disk.grow?.state === 'failed' ? 'admin-bad' : 'usage-dim'}>last grow: {grow}</div>}
      {volume && (disk.refusal
        ? <div className="usage-dim">can't grow: {disk.refusal}</div>
        : (
          <form className="admin-form" onSubmit={e => { e.preventDefault(); void submit(); }}>
            <input type="number" min={volume.sizeGb} max={disk.maxGb} step={1} value={sizeGb} onChange={e => setSizeGb(e.target.value)}
              placeholder={String(fallback)} style={{ maxWidth: 90 }} aria-label="new size in GB" />
            <span className="usage-dim">GB</span>
            <button type="submit" className="btn-ghost btn-tiny" disabled={busy || !Number.isInteger(target) || target < volume.sizeGb}>Grow disk</button>
          </form>
        ))}
      {err && <div className="admin-error">{err}</div>}
    </div>
  );
}
