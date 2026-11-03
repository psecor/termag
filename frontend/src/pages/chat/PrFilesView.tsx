// A PR's Files changed, as GitHub names the tab:
// each file's diff (GET /api/prs/:owner/:repo/:n/files), with every review
// thread on the line it is about (GET …/threads: Bugbot's, a teammate's, the
// user's own), resolved and outdated ones folded, and, where a review is being
// drafted, the comments it would post shown as drafts on their lines. A line
// asked for (a finding clicked in the review card) is marked and scrolled to.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Button, ProgressBar } from '@launchpad-ui/components';
import { Icon } from '@launchpad-ui/icons';
import { prsApi, type PrFilePatch, type PrFiles, type PrThread } from '../../services/api';
import { apiErrorText } from '../../utils/prPipeline';
import { parsePatch } from '../../chat/diff';
import { initials, withCode } from './reviewText';
import { Markdown } from '../../chat/Markdown';
import { prDescription } from '../../utils/prDescription';

/** A comment a review would post, drawn on its line before it posts. */
export interface DraftComment {
  key: string;
  path: string;
  line: number;
  body: string;
  /** Who it posts as. */
  who: string;
  onRemove?: () => void;
}

const STATUS_LETTER: Record<PrFilePatch['status'], string> = { added: 'A', removed: 'D', modified: 'M', renamed: 'R', copied: 'C', changed: 'M', unchanged: '·' };

/** One review thread on a line: its comments are GitHub markdown (chat/Markdown.tsx), collapsed once resolved or outdated. */
export function Thread({ t }: { t: PrThread }) {
  const [open, setOpen] = useState(!t.resolved && !t.outdated);
  const first = t.comments[0];
  const total = Math.max(t.total ?? 0, t.comments.length);
  const more = total - t.comments.length;
  return (
    <div className="rv-thread" data-resolved={t.resolved || undefined} data-outdated={t.outdated || undefined}>
      <button type="button" className="rv-thread-head" aria-expanded={open} onClick={() => setOpen(o => !o)}>
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size="small" aria-hidden="true" />
        <span className="rv-thread-who">{first?.author ?? 'someone'}{first?.bot && <span className="rv-bot">bot</span>}</span>
        <span className="rv-thread-meta">{total} {total === 1 ? 'comment' : 'comments'}</span>
        {t.resolved && <span className="rv-pill" data-tone="ok">Resolved</span>}
        {t.outdated && <span className="rv-pill">Outdated</span>}
      </button>
      {open && t.comments.map(c => (
        <div key={c.id} className="rv-comment">
          <span className="rv-comment-av" aria-hidden="true">{initials(c.author)}</span>
          <div className="rv-comment-body">
            <div className="rv-comment-head">
              <span className="rv-comment-who">{c.author ?? 'someone'}</span>
              {c.url && <a href={c.url} target="_blank" rel="noopener noreferrer" className="rv-comment-gh">GitHub</a>}
            </div>
            <div className="rv-comment-text"><Markdown text={prDescription(c.body)} /></div>
          </div>
        </div>
      ))}
      {open && more > 0 && (
        <p className="rv-note">
          {more} more {more === 1 ? 'comment' : 'comments'}{first?.url ? <> on <a href={first.url} target="_blank" rel="noopener noreferrer">GitHub</a></> : ' on GitHub'}
        </p>
      )}
    </div>
  );
}

function Draft({ d }: { d: DraftComment }) {
  return (
    <div className="rv-draft" role="note" aria-label={`Draft comment on line ${d.line}`}>
      <div className="rv-draft-head">
        <span className="rv-comment-av" aria-hidden="true">{initials(d.who)}</span>
        <span>Draft · posts as {d.who}</span>
        {d.onRemove && <span className="rv-draft-acts"><Button variant="minimal" size="small" onPress={d.onRemove}>Leave it out</Button></span>}
      </div>
      <p className="rv-draft-body">{withCode(d.body)}</p>
    </div>
  );
}

function FileDiff({ f, threads, drafts, focusLine, focusAt }: { f: PrFilePatch; threads: PrThread[]; drafts: DraftComment[]; focusLine: number | null; focusAt?: number }) {
  const rows = useMemo(() => parsePatch(f.patch), [f.patch]);
  const busy = threads.length + drafts.length > 0 || focusLine != null;
  const [open, setOpen] = useState(busy || rows.length < 80);
  useEffect(() => { if (busy) setOpen(true); }, [busy]);
  // Asked to show a line here, again too: open the file even if it was folded since.
  useEffect(() => { if (focusLine != null) setOpen(true); }, [focusLine, focusAt]);
  // What the focus scrolls to: its line, else (a line the patch doesn't show) the drafts under the file, else the file.
  // A ref each: one shared by all three could be nulled by the element losing it after another took it.
  const lineRef = useRef<HTMLDivElement>(null);
  const looseRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (open && focusLine != null) (lineRef.current ?? looseRef.current ?? fileRef.current)?.scrollIntoView({ block: 'center' });
  }, [open, focusLine, focusAt]);
  // A thread sits on its side's line: the head's (RIGHT, a row's new number) or the base's (LEFT, a removed
  // or context row's old number). Drafts are on the head.
  const sits = (t: PrThread, r: { old: number | null; new: number | null }) =>
    t.line != null && (t.side === 'LEFT' ? r.old === t.line : r.new === t.line);
  const onLine = (r: { old: number | null; new: number | null }) => ({
    threads: threads.filter(t => sits(t, r)),
    drafts: r.new == null ? [] : drafts.filter(d => d.line === r.new),
  });
  // Threads GitHub can't place on this patch (outdated, or on a line it doesn't show) go under the file, and so
  // does a draft on a line the patch doesn't show (it posts in the review's summary instead).
  const loose = threads.filter(t => !rows.some(r => r.kind !== 'hunk' && sits(t, r)));
  const looseDrafts = drafts.filter(d => !rows.some(r => r.new === d.line));
  const lineShown = focusLine != null && rows.some(r => r.kind !== 'hunk' && r.new === focusLine);
  const looseShown = loose.length > 0 || looseDrafts.length > 0;
  return (
    <section className="rv-file" aria-label={f.path} ref={focusLine != null && !lineShown && !looseShown ? fileRef : undefined}>
      <button type="button" className="rv-file-head" aria-expanded={open} onClick={() => setOpen(o => !o)}>
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size="small" aria-hidden="true" />
        <span className="rv-file-status" data-status={f.status}>{STATUS_LETTER[f.status]}</span>
        <code className="rv-file-path">{f.previousPath ? `${f.previousPath} → ${f.path}` : f.path}</code>
        <span className="rv-add">+{f.additions}</span><span className="rv-del">−{f.deletions}</span>
        {threads.length > 0 && <span className="rv-pill">{threads.length} {threads.length === 1 ? 'thread' : 'threads'}</span>}
        {drafts.length > 0 && <span className="rv-pill" data-tone="info">{drafts.length} {drafts.length === 1 ? 'draft' : 'drafts'}</span>}
      </button>
      {open && (
        <div className="rv-diff" role="table" aria-label={`Changes to ${f.path}`}>
          {!f.patch && <div className="rv-diff-none">{f.capped ? 'termag leaves this diff out: the PR\'s diff is past what it shows. It\'s on GitHub.' : 'GitHub shows no diff for this file (binary, or too large).'}</div>}
          {rows.map((r, i) => {
            const at = onLine(r);
            const hl = focusLine != null && r.new === focusLine;
            return (
              <React.Fragment key={i}>
                {r.kind === 'hunk'
                  ? <div className="rv-hunk" role="row">{r.text}</div>
                  : (
                    <div className="rv-line" role="row" data-kind={r.kind} data-focus={hl || undefined} ref={hl ? lineRef : undefined}>
                      <span className="rv-ln" role="cell">{r.old ?? ''}</span>
                      <span className="rv-ln" role="cell">{r.new ?? ''}</span>
                      <span className="rv-sign" role="cell">{r.kind === 'add' ? '+' : r.kind === 'del' ? '−' : ' '}</span>
                      <span className="rv-code" role="cell">{r.text}</span>
                    </div>
                  )}
                {(at.threads.length > 0 || at.drafts.length > 0) && (
                  <div className="rv-on-line">
                    {at.threads.map(t => <Thread key={t.id} t={t} />)}
                    {at.drafts.map(d => <Draft key={d.key} d={d} />)}
                  </div>
                )}
              </React.Fragment>
            );
          })}
          {looseShown && (
            <div className="rv-on-line rv-loose" ref={focusLine != null && !lineShown ? looseRef : undefined}>
              {loose.map(t => <Thread key={t.id} t={t} />)}
              {looseDrafts.map(d => <Draft key={d.key} d={d} />)}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

export function PrFilesView({ repo, number, drafts = [], focus }: {
  repo: string; number: number; drafts?: DraftComment[]; focus?: { path: string; line: number; at?: number } | null;
}) {
  const [files, setFiles] = useState<PrFiles | null>(null);
  const [threads, setThreads] = useState<PrThread[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    // Another PR: nothing of the last one's stays on screen while this one is read.
    setFiles(null); setError(null);
    prsApi.files(repo, number).then(f => { if (live) setFiles(f); }, err => { if (live) setError(apiErrorText(err, 'Could not read the diff from GitHub')); });
    return () => { live = false; };
  }, [repo, number]);
  // The threads are read on their own, and again on Read again: the diff stands without them, but says so.
  const [threadsFailed, setThreadsFailed] = useState(false);
  const [threadReads, setThreadReads] = useState(0);
  useEffect(() => {
    let live = true;
    setThreads([]); setThreadsFailed(false);
    prsApi.threads(repo, number).then(t => { if (live) setThreads(t); }, () => { if (live) setThreadsFailed(true); });
    return () => { live = false; };
  }, [repo, number, threadReads]);
  // A finding on a file the diff doesn't list: its draft is in the section at the foot, so that's what shows.
  const foot = useRef<HTMLElement | null>(null);
  const focusElsewhere = !!focus && !!files && !files.files.some(f => f.path === focus.path || f.previousPath === focus.path);
  useEffect(() => { if (focusElsewhere) foot.current?.scrollIntoView({ block: 'center' }); }, [focusElsewhere, focus?.at]);
  if (error) return <p className="rv-note">{error}</p>;
  if (!files) return <div className="rv-loading-line"><ProgressBar variant="spinner" size="small" isIndeterminate aria-label="Reading the diff" /> Reading the diff…</div>;
  const open = threads.filter(t => !t.resolved).length;
  // A thread on a file the list doesn't have (past the file cap, or no longer in the diff) is still shown.
  const listed = new Set(files.files.flatMap(f => (f.previousPath ? [f.path, f.previousPath] : [f.path])));
  // A thread on a renamed file's old path sits with it, unless a file the diff lists is at that path now (a rename
  // and a new file in its place): then it's that file's, and drawn once.
  const current = new Set(files.files.map(f => f.path));
  const onFile = (f: PrFilePatch, path: string) => path === f.path || (f.previousPath != null && path === f.previousPath && !current.has(path));
  const elsewhere = threads.filter(t => !listed.has(t.path));
  const draftsElsewhere = drafts.filter(d => !listed.has(d.path));
  return (
    <div className="rv-files">
      <div className="rv-files-sum">
        {files.files.length} {files.files.length === 1 ? 'file' : 'files'}
        <span className="rv-add">+{files.files.reduce((n, f) => n + f.additions, 0)}</span>
        <span className="rv-del">−{files.files.reduce((n, f) => n + f.deletions, 0)}</span>
        {threads.length > 0 && <span>· {threads.length} review {threads.length === 1 ? 'thread' : 'threads'}, {open} open</span>}
        {files.truncated && <span>· more than termag shows: the rest is on GitHub</span>}
        {threadsFailed && (
          <span role="alert">
            · couldn't read the review threads from GitHub, so none show here{' '}
            <Button size="small" variant="minimal" onPress={() => setThreadReads(n => n + 1)}>Read again</Button>
          </span>
        )}
      </div>
      {files.files.map(f => {
        // A thread, draft or finding naming the file, or a rename's old path no listed file is at now (onFile).
        const here = (path: string) => onFile(f, path);
        const focused = focus && here(focus.path) ? focus : null;
        return (
          <FileDiff key={f.path} f={f} threads={threads.filter(t => here(t.path))} drafts={drafts.filter(d => here(d.path))}
            focusLine={focused ? focused.line : null} focusAt={focused?.at} />
        );
      })}
      {(elsewhere.length > 0 || draftsElsewhere.length > 0 || focusElsewhere) && (
        <section className="rv-file" aria-label="Threads on files not shown here" ref={el => { foot.current = el; }}>
          <div className="rv-file-head rv-file-head-static">
            <span className="rv-file-path-plain">On files this diff doesn't show</span>
            <span className="rv-pill">{elsewhere.length + draftsElsewhere.length}</span>
          </div>
          <div className="rv-on-line rv-loose">
            {/* A finding asked for here with no draft (unticked): where it is, so the click has something to show. */}
            {focus && focusElsewhere && !draftsElsewhere.some(d => d.path === focus.path && d.line === focus.line) && (
              <p className="rv-note" data-focus="">
                <code className="rv-file-path">{focus.path}:{focus.line}</code> isn't in this diff (past what termag shows, or no longer changed). It's on GitHub.
              </p>
            )}
            {elsewhere.map(t => <div key={t.id}><code className="rv-file-path">{t.path}</code><Thread t={t} /></div>)}
            {draftsElsewhere.map(d => <div key={d.key}><code className="rv-file-path">{d.path}</code><Draft d={d} /></div>)}
          </div>
        </section>
      )}
    </div>
  );
}
