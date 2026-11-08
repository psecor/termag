import { useCallback, useEffect, useRef, useState } from 'react';
import type { BoxSize } from '../utils/boxSize';
import { instancesApi } from '../services/api';
import {
  busyRefusal, defaultResizeTarget, growFieldOptions, resizeError, resizeFromStatus, type BoxResizeInfo, type GrowView, type ResizeView,
} from '../utils/boxResize';
import { diskInputError, diskToSend, type BoxDiskOptions } from '../utils/boxDisk';

/** How often a dialog reads the resize again while it runs; the phases also arrive on the status socket's box list reloads. */
export const RESIZE_POLL_MS = 2_500;

export interface BoxResizeApi {
  load: () => Promise<BoxResizeInfo>;
  send: (size: BoxSize, force: boolean) => Promise<{ resize: ResizeView }>;
  /** The owner's dialogs: grow the box's disk (POST /api/instances/:id/disk). Without it, the dialog has no disk field. */
  grow?: (sizeGb: number) => Promise<{ grow: GrowView | null; alreadyGb?: number }>;
}

export interface BoxResizeState {
  info: BoxResizeInfo | null;
  loadError: string | null;
  picked: BoxSize | null;
  setPicked: (size: BoxSize) => void;
  submitting: boolean;
  error: string | null;
  /** The resize this dialog asked for, or one already running when it opened. */
  resize: ResizeView | null;
  /** The box's status when the resize was asked for, for the progress list. */
  fromStatus: string | null;
  /** Resize: always the confirmed request (`force`), since the dialog's one warning is the confirmation. */
  submit: () => Promise<void>;
  /** The disk field's range (grow only, up to the server's cap); null without a disk to grow. */
  diskOptions: BoxDiskOptions | null;
  /** What was typed in the disk field; null while it shows the current disk. */
  diskTyped: string | null;
  setDiskTyped: (typed: string) => void;
  diskError: string | null;
  /** The GB the disk grows to, or null when it doesn't change. */
  diskTarget: number | null;
  /** Whether the size changes: a pick other than the current size. */
  sizeChanges: boolean;
  /** Whether the dialog can send what is picked now. */
  canSubmit: boolean;
  /** The grow this dialog asked for, or one already running when it opened. */
  grow: GrowView | null;
  /** This dialog asked for the disk with the size: the resize's steps start with waiting for it. */
  withDisk: boolean;
  /** The grow is this dialog's to show: it asked for it, or found it running. */
  growShown: boolean;
  /** A grow that got the volume but not its file system: retryGrow finishes it at the same size. */
  retry: { sizeGb: number; error: string | null } | null;
  retryGrow: () => Promise<void>;
  /** Something this dialog asked for (or found running) is under way or has just ended: show the progress. */
  showProgress: boolean;
}

/**
 * One resize dialog's state, for both UIs and the Fleet tab: load what the
 * server offers, send the pick (confirmed), and read the resize again until
 * it has finished.
 */
export function useBoxResize(api: BoxResizeApi, onChanged?: () => void): BoxResizeState {
  const [info, setInfo] = useState<BoxResizeInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [picked, setPicked] = useState<BoxSize | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fromStatus, setFromStatus] = useState<string | null>(null);
  const [diskTyped, setDiskTyped] = useState<string | null>(null);
  const [growAsked, setGrowAsked] = useState(false);
  const [withDisk, setWithDisk] = useState(false);
  const apiRef = useRef(api);
  apiRef.current = api;
  const changedRef = useRef(onChanged);
  changedRef.current = onChanged;

  const load = useCallback(async () => {
    try {
      const next = await apiRef.current.load();
      setInfo(next);
      setLoadError(null);
      return next;
    } catch (err) {
      setLoadError(resizeError(err, 'Could not load the box'));
      return null;
    }
  }, []);

  useEffect(() => {
    void load().then(next => {
      if (!next) return;
      // With a disk field, the dialog opens on no change (size and disk both as they are), so changing
      // only the disk never resizes too; the Fleet tab's size-only form preselects the next size up.
      const keep = apiRef.current.grow && next.disk && next.sizes.some(c => c.size === next.box.size);
      setPicked(p => p ?? (keep ? next.box.size as BoxSize : defaultResizeTarget(next.box.size, next.sizes)));
      if (next.resize?.running) setFromStatus(resizeFromStatus(next.resize, next.box.status));
      if (next.resize?.running && next.resize.phase === 'disk') setWithDisk(true);
      if (next.disk?.grow?.running) setGrowAsked(true);
    });
  }, [load]);

  const running = !!info?.resize?.running || !!info?.disk?.grow?.running;
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => {
      void load().then(next => {
        if (!next) return;
        // A later read corrects the steps if the server's record differs.
        const recorded = next.resize?.fromStatus;
        if (recorded) setFromStatus(f => (f === null ? f : recorded));
        if (!next.resize?.running && !next.disk?.grow?.running) changedRef.current?.();
      });
    }, RESIZE_POLL_MS);
    return () => clearInterval(t);
  }, [running, load]);

  const diskOptions = apiRef.current.grow ? growFieldOptions(info?.disk) : null;
  const diskError = diskInputError(diskOptions, diskTyped);
  const typedDisk = diskToSend(diskOptions, diskTyped);
  const diskTarget = diskOptions && typedDisk !== undefined && typedDisk > diskOptions.minGiB && !info?.disk?.refusal ? typedDisk : null;
  const sizeChanges = !!info && !!picked && picked !== info.box.size && !info.refusal;
  const canSubmit = !!info && !submitting && !diskError && (sizeChanges || diskTarget !== null);

  const submit = useCallback(async () => {
    if (!info || !canSubmit) return;
    setSubmitting(true);
    setError(null);
    let next = info;
    try {
      // The disk first, with the box up: a refusal (EBS's six hours, say) stops here, before anything is
      // stopped. A resize asked for next waits for the grow before it stops the box (backend boxResize.ts).
      if (diskTarget !== null && apiRef.current.grow) {
        const { grow } = await apiRef.current.grow(diskTarget);
        // No grow: the disk already had that size (it changed since this dialog loaded), so there is nothing to follow.
        if (grow) {
          next = { ...next, disk: next.disk ? { ...next.disk, grow } : next.disk };
          setGrowAsked(true);
          setInfo(next);
        }
      }
      if (sizeChanges && picked) {
        // The warning was the confirmation: what is running stops (the server's
        // busy refusal is for the CLI and the API). A claim or a box update in
        // flight still refuses, and its reason shows as the error.
        const { resize } = await apiRef.current.send(picked, true);
        // The server's record of what the resize started from (the box may have
        // moved since this dialog loaded); the loaded status only from an older one.
        setFromStatus(resizeFromStatus(resize, info.box.status));
        setWithDisk(diskTarget !== null);
        next = { ...next, resize };
        setInfo(next);
      }
      changedRef.current?.();
    } catch (err) {
      setError(busyRefusal(err)?.error ?? resizeError(err, next !== info ? 'Could not resize the box' : diskTarget !== null ? 'Could not grow the disk' : 'Could not resize the box'));
    } finally {
      setSubmitting(false);
    }
  }, [info, picked, canSubmit, diskTarget, sizeChanges]);

  const retry = apiRef.current.grow ? info?.disk?.retry ?? null : null;
  // Same size: the server re-runs only the file system step, which EBS's six hours don't cover (Devin on #1214).
  const retryGrow = useCallback(async () => {
    if (!info || !retry || !apiRef.current.grow) return;
    setSubmitting(true);
    setError(null);
    try {
      const { grow } = await apiRef.current.grow(retry.sizeGb);
      // No grow: the server found nothing left to finish; read the box again rather than follow one.
      if (grow) {
        setGrowAsked(true);
        setInfo({ ...info, disk: info.disk ? { ...info.disk, grow, retry: null } : info.disk });
      } else {
        await load();
      }
      changedRef.current?.();
    } catch (err) {
      setError(resizeError(err, 'Could not grow the disk'));
    } finally {
      setSubmitting(false);
    }
  }, [info, retry, load]);

  const grow = info?.disk?.grow ?? null;
  const growShown = growAsked && !!grow;
  const showProgress = (fromStatus !== null && !!info?.resize) || growShown;
  return {
    info, loadError, picked, setPicked, submitting, error,
    resize: info?.resize ?? null, fromStatus, submit,
    diskOptions, diskTyped, setDiskTyped, diskError, diskTarget, sizeChanges, canSubmit, grow, growShown, withDisk, showProgress, retry, retryGrow,
  };
}

let sizesCache: Promise<BoxResizeInfo['sizes']> | null = null;

/**
 * The size table (vCPUs, memory) for menu labels, read once per page from the
 * first box's resize info; null until it answers, or when it can't.
 */
export function useResizeSizes(boxId: string | null | undefined): BoxResizeInfo['sizes'] | null {
  const [sizes, setSizes] = useState<BoxResizeInfo['sizes'] | null>(null);
  useEffect(() => {
    if (!boxId) return;
    let cancelled = false;
    // A label only: a lookup that throws at once must not take the chat view down with it.
    sizesCache ??= Promise.resolve(boxId).then(id => instancesApi.resizeInfo(id)).then(i => i.sizes);
    sizesCache.then(s => { if (!cancelled) setSizes(s); }).catch(() => { sizesCache = null; });
    return () => { cancelled = true; };
  }, [boxId]);
  return sizes;
}
