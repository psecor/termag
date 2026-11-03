import { useCallback, useEffect, useRef, useState } from 'react';
import type { BoxSize } from '../utils/boxSize';
import { instancesApi } from '../services/api';
import {
  busyRefusal, defaultResizeTarget, resizeError, resizeFromStatus, type BoxResizeInfo, type ResizeView,
} from '../utils/boxResize';

/** How often a dialog reads the resize again while it runs; the phases also arrive on the status socket's box list reloads. */
export const RESIZE_POLL_MS = 2_500;

export interface BoxResizeApi {
  load: () => Promise<BoxResizeInfo>;
  send: (size: BoxSize, force: boolean) => Promise<{ resize: ResizeView }>;
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
      setPicked(p => p ?? defaultResizeTarget(next.box.size, next.sizes));
      if (next.resize?.running) setFromStatus(resizeFromStatus(next.resize, next.box.status));
    });
  }, [load]);

  const running = !!info?.resize?.running;
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => {
      void load().then(next => {
        if (!next) return;
        // A later read corrects the steps if the server's record differs.
        const recorded = next.resize?.fromStatus;
        if (recorded) setFromStatus(f => (f === null ? f : recorded));
        if (!next.resize?.running) changedRef.current?.();
      });
    }, RESIZE_POLL_MS);
    return () => clearInterval(t);
  }, [running, load]);

  const submit = useCallback(async () => {
    if (!info || !picked) return;
    setSubmitting(true);
    setError(null);
    try {
      // The warning was the confirmation: what is running stops (the server's
      // busy refusal is for the CLI and the API). A claim or a box update in
      // flight still refuses, and its reason shows as the error.
      const { resize } = await apiRef.current.send(picked, true);
      // The server's record of what the resize started from (the box may have
      // moved since this dialog loaded); the loaded status only from an older one.
      setFromStatus(resizeFromStatus(resize, info.box.status));
      setInfo({ ...info, resize });
      changedRef.current?.();
    } catch (err) {
      setError(busyRefusal(err)?.error ?? resizeError(err));
    } finally {
      setSubmitting(false);
    }
  }, [info, picked]);

  return {
    info, loadError, picked, setPicked, submitting, error,
    resize: info?.resize ?? null, fromStatus, submit,
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
