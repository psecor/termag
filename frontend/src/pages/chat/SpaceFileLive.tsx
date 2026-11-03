// Live space files in the simple UI.
// useSpaceFileLive keeps the open file view (SpaceFileView.tsx) current: a
// `space-file` frame for its file reloads it in place, without the Loading…
// state, so the page keeps its scroll and whatever sits beside the content
// (the file chat's composer and reply strip) is left as it was; a removed or
// moved file shows as gone. Nothing polls: files/head (If-None-Match) is
// asked once when the file opens, for the version on screen, and once each
// time frames may have been missed (the status socket reopened, or the
// server's LISTEN connection came back: a resync) or a frame came without
// paths. A presigned PUT nobody confirmed sends no frame, so it shows only at
// the next check or a reload. LiveCue is the brief "Updated" pill.
// useSpaceListingLive refetches the explorer's open folders, keeping what
// they show until the new listing arrives.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { spacesApi, type SpaceTree } from '../../services/api';
import { itemHref } from '../../chat/openItems';
import { CUE_MS, effectOnFile, holdsOnChange, spaceFileEvents, touchesSpace } from '../../chat/spaceFileLive';
import './fileLive.css';

export type LiveCueState = { kind: 'updated' | 'pending' | 'deleted' | 'moved'; to?: string; n: number } | null;

const errorCode = (err: unknown) => (err as { response?: { data?: { code?: string } } })?.response?.data?.code;

/**
 * Who reads the file: a member of the space, someone who reached it through a
 * share with everyone on termag (they get no frames, and files/head is a 404
 * for them), or not known yet. Only a member is kept live.
 */
export type FileReader = 'member' | 'share' | 'unknown';

/**
 * The file view's live side. `setLoaded` stands in for the view's own setter:
 * during a live reload it drops the Loading… and error states (an error keeps
 * what is shown) and shows the cue when the new content lands. Nothing runs
 * (no frames followed, no files/head) until `reader` is a member, and a check
 * the server refuses for the space (`not_found`, no role) ends the checks for
 * this file without changing what is shown.
 */
export function useSpaceFileLive<L extends { state: string }>(o: {
  space: string; path: string; loaded: L; setLoaded: (v: L) => void; reload: () => void; gone: L;
  /** Unset is a member, as the file view without file sharing is. */
  reader?: FileReader;
}) {
  const member = (o.reader ?? 'member') === 'member';
  const key = `${o.space}\0${o.path}`;
  const opts = useRef(o);
  opts.current = o;
  const st = useRef({ key, quiet: false, etag: null as string | null, gone: false, checking: false, refused: false });
  if (st.current.key !== key) st.current = { key, quiet: false, etag: null, gone: false, checking: false, refused: false };
  const [cue, setCue] = useState<LiveCueState>(null);
  const show = useCallback((kind: NonNullable<LiveCueState>['kind'], to?: string) => {
    setCue(c => ({ kind, ...(to !== undefined ? { to } : {}), n: (c?.n ?? 0) + 1 }));
  }, []);
  useEffect(() => { setCue(null); }, [key]);

  const setLoaded = useCallback((v: L) => {
    const s = st.current;
    if (s.quiet) {
      if (v.state === 'loading') return;
      s.quiet = false;
      if (v.state === 'error') return;
      if (v.state === 'ok') show('updated');
      if (v.state === 'gone' && !s.gone) show('deleted');
    }
    s.gone = v.state === 'gone';
    opts.current.setLoaded(v);
  }, [show]);

  const apply = useCallback(() => {
    if (holdsOnChange(opts.current.loaded as { state: string })) { show('pending'); return; }
    st.current.quiet = true;
    opts.current.reload();
  }, [show]);

  const markGone = useCallback((movedTo?: string) => {
    const s = st.current;
    s.quiet = false;
    s.gone = true;
    opts.current.setLoaded(opts.current.gone);
    show(movedTo !== undefined ? 'moved' : 'deleted', movedTo);
  }, [show]);

  const check = useCallback(async () => {
    const s = st.current;
    if (s.checking || s.refused) return;
    s.checking = true;
    try {
      const head = await spacesApi.fileHead(opts.current.space, opts.current.path, s.etag);
      if (st.current !== s || !head) return;
      const before = s.etag;
      s.etag = head.etag;
      if (s.gone || (before !== null && head.etag !== before)) apply();
    } catch (err) {
      if (st.current !== s) return;
      const code = errorCode(err);
      if (code === 'not_found') s.refused = true;
      else if (code === 'file_not_found' && !s.gone) markGone();
    } finally {
      s.checking = false;
    }
  }, [apply, markGone]);

  useEffect(() => {
    if (!member) return;
    const off = spaceFileEvents.subscribe(frame => {
      const effect = effectOnFile(frame, opts.current.space, opts.current.path);
      const s = st.current;
      if (!effect || s.refused) return;
      if (effect.kind === 'check') { void check(); return; }
      if (effect.kind === 'gone') { markGone(effect.movedTo); return; }
      if (effect.etag && effect.etag === s.etag && !s.gone) return;
      s.etag = effect.etag ?? null;
      apply();
      // No version in the frame: learn it, so a later check compares against this one.
      if (!effect.etag) void check();
    });
    // The version on screen, for the checks after a missed frame. Once, not a poll.
    void check();
    return off;
  }, [member, key, apply, check, markGone]);

  /** The cue's Reload, for a view that waits (holdsOnChange). */
  const applyPending = useCallback(() => {
    st.current.quiet = true;
    opts.current.reload();
  }, []);

  return { setLoaded, cue, applyPending };
}

/** The brief cue at the top of the file view: Updated, Deleted, Moved to …, or Changed · Reload. */
export function LiveCue({ space, cue, onReload }: { space: string; cue: LiveCueState; onReload: () => void }) {
  const [shown, setShown] = useState<LiveCueState>(null);
  useEffect(() => {
    setShown(cue);
    if (!cue || cue.kind === 'pending' || cue.kind === 'moved') return;
    const t = setTimeout(() => setShown(null), CUE_MS);
    return () => clearTimeout(t);
  }, [cue]);
  return (
    <div className="fv-live-cue" role="status" aria-live="polite" data-kind={shown?.kind} hidden={!shown}>
      {shown?.kind === 'updated' && 'Updated'}
      {shown?.kind === 'deleted' && 'Deleted'}
      {shown?.kind === 'moved' && shown.to !== undefined && (
        <>Moved to <Link to={itemHref({ kind: 'file', space, path: shown.to })}>{shown.to}</Link></>
      )}
      {shown?.kind === 'pending' && (
        <>Changed <button type="button" className="btn-tiny" onClick={() => { setShown(null); onReload(); }}>Reload</button></>
      )}
    </div>
  );
}

type LiveListing = { tree: SpaceTree | null; error: string | null; more?: boolean };

/** Most pages a refresh reads to cover what More had loaded. */
const REFRESH_MAX_PAGES = 50;

/** `prefix` again, as many pages as it takes to cover the `shown` entries it had (what More loaded). */
async function listAgain(space: string, prefix: string, shown: number): Promise<SpaceTree> {
  let tree = await spacesApi.tree(space, prefix);
  for (let pages = 1; tree.nextCursor && tree.dirs.length + tree.files.length < shown && pages < REFRESH_MAX_PAGES; pages++) {
    const next = await spacesApi.tree(space, prefix, tree.nextCursor);
    tree = { ...next, dirs: [...tree.dirs, ...next.dirs], files: [...tree.files, ...next.files] };
  }
  return tree;
}

/**
 * Keeps the explorer's open folders of `space` current: a frame for the space
 * (or a resync) refetches each folder it has, after a short pause so a folder
 * move is one refetch, and swaps each in when it arrives. The refetch starts a
 * new generation of the explorer's cache, as Refresh does but keeping what is
 * shown, so nothing begun before the change can land after it: a folder's
 * first load, a More, the search index. So folders still loading are refetched
 * too, a folder is read for as many pages as More had loaded, only the newest
 * refetch of a folder is shown, and the search index is dropped so a search
 * lists again.
 */
export function useSpaceListingLive(space: string, cache: { listings: Map<string, LiveListing>; index: unknown; gen: number }, rerender: () => void) {
  const latest = useRef({ cache, rerender });
  latest.current = { cache, rerender };
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    /** The newest refetch of each folder. */
    const newest = new Map<string, number>();
    let seq = 0;
    const refetch = () => {
      timer = null;
      const { cache: c, rerender: draw } = latest.current;
      const gen = ++c.gen;
      c.index = null;
      for (const [prefix, l] of [...c.listings]) {
        const n = ++seq;
        newest.set(prefix, n);
        // A More in flight was dropped with its generation: show the folder as it was.
        if (l.more) c.listings.set(prefix, { tree: l.tree, error: l.error });
        const current = () => c.gen === gen && newest.get(prefix) === n && c.listings.has(prefix);
        listAgain(space, prefix, l.tree ? l.tree.dirs.length + l.tree.files.length : 0)
          .then(tree => { if (current()) { c.listings.set(prefix, { tree, error: null }); draw(); } })
          .catch(() => {
            // Keep a listing that was shown; a folder that had none says it couldn't be listed.
            if (current() && !c.listings.get(prefix)?.tree) { c.listings.set(prefix, { tree: null, error: 'Could not list this folder' }); draw(); }
          });
      }
      draw();
    };
    const off = spaceFileEvents.subscribe(frame => {
      if (!touchesSpace(frame, space)) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(refetch, 300);
    });
    return () => { off(); if (timer) clearTimeout(timer); };
  }, [space]);
}
