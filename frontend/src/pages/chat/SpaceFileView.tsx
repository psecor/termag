// One space file in the simple UI's main pane (/chat/f/<space>/<path>),
// opened from the file explorer, the sidebar
// or a space link in a reply. The server signs a 30-minute presigned S3 URL
// and says how to show it. PDFs are the src
// of an unsandboxed iframe and the browser's own viewer renders them. Text
// and code are fetched (the first CODE_VIEW_MAX_BYTES) and shown by CodeView:
// line numbers, highlight.js, a wrap toggle; a .mmd or .mermaid file is its
// Mermaid diagram (chat/MermaidBlock.tsx), source a toggle away. Images are an <img> scaled to
// fit (a phone's frame shows one at full size, cut off), and video and audio
// the browser's player, inline (an iframe of a video goes full screen on an
// iPhone). A touch screen gets
// an Open PDF button instead of a framed PDF: iOS Safari draws only the
// first page in a frame and Android Chrome draws nothing. Markdown, HTML and SVG are signed as
// plain text and fetched: Markdown is rendered by the chat's renderer (text
// only, no HTML; an image of a file in this space is shown, any other is linked and never
// fetched, SpaceMarkdownImage.tsx), HTML is the srcdoc of an iframe
// sandboxed with no allowances (no scripts, an opaque origin), SVG is a data:
// URL in an <img>. Types the browser can't show are a download. A path
// that names a folder, not a file (a folder's link without its trailing
// slash), opens that folder in the space's explorer instead, in the same
// tab (chat/openItems.ts folderHref). The space's
// explorer is the side panel's Files tab, and Tools opens it, as does a folder
// of the header's breadcrumb, with that folder open. A file picked
// in the explorer replaces this one in the same tab. The breadcrumb is the
// header's only title line. Reload and Download are icons (named by their
// aria-label, with a tooltip on hover or focus). The buttons go Reload,
// Download, Share | 🔗, then Tools, beside the panel it opens, as in every
// chat header; on a phone (or a header too narrow for them) they are under ⋮
// in the same order, as an agent's actions are. The back arrow at the
// header's left, before the breadcrumb and the same button as Reload, closes
// the file's tab and goes back to the tab shown before it (TabClose.tsx).
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { spacesApi, type SpaceViewUrl } from '../../services/api';
import { Dialog } from '../../components/Dialog';
import { announceShared, linkAudience, skipShareConfirm, skipsShareConfirm } from '../../chat/fileShare';
import { downloadFile, errorMessage } from '../../services/spaceTransfer';
import { formatBytes, spaceFileLink, TEXT_PREVIEW_MAX_BYTES } from '../../utils/spaces';
import { Markdown } from '../../chat/Markdown';
import { fetchesText, fileCrumbs, fileShow, foldedCrumbs, headerNeedsMenu, showsAsCode, svgDataUrl, type FileShow } from '../../chat/fileExplorer';
import { CODE_VIEW_MAX_BYTES } from '../../chat/codeView';
import { CodeView } from './CodeView';
import { MermaidBlock } from '../../chat/MermaidBlock';
import { isMermaidPath } from '../../chat/mermaidFence';
import { LiveCue, useSpaceFileLive } from './SpaceFileLive';
import { REPLAY_BLOCK_CLASS } from '../../observability';
import { ChatHistoryButton, SidePanelButton, useChatChrome } from './chatChrome';
import { CloseAndBackButton } from './TabClose';
import { menuButtonKeys, useCoarsePointer, useContextMenu, type MenuTrigger } from './ContextMenu';
import { FileComposeLinks, SpaceFileChat } from './FileChat';
import { SpaceMarkdownImages } from './SpaceMarkdownImage';
import { folderHref, tabForRoute } from '../../chat/openItems';
import { useSimpleDataIfAny } from './simpleData';

type Loaded =
  | { state: 'loading' }
  | { state: 'gone'; notShared?: boolean }
  | { state: 'error'; text: string }
  | { state: 'ok'; url: string; size: number; type: string; show: FileShow; text?: string; truncated?: boolean };

type ShareState = NonNullable<SpaceViewUrl['share']>;

function localStore(): Storage | null {
  try { return window.localStorage; } catch { return null; }
}

function LockIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <rect x="3.5" y="7" width="9" height="6.5" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" fill="none" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

function PeopleIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <circle cx="6" cy="5.5" r="2.3" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M1.8 13.5c.4-2.4 2.1-3.8 4.2-3.8s3.8 1.4 4.2 3.8" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M10.6 3.4a2.3 2.3 0 0 1 0 4.3M12.2 9.9c1.1.5 1.8 1.7 2 3.6" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function LinkIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path d="M6.8 9.2a2.8 2.8 0 0 0 4 0l2-2a2.8 2.8 0 0 0-4-4l-.7.7M9.2 6.8a2.8 2.8 0 0 0-4 0l-2 2a2.8 2.8 0 0 0 4 4l.7-.7"
        fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

/** Turning sharing on: who will be able to see the file, and "Don't ask again" for this space. */
function ShareConfirm({ name, space, onCancel, onConfirm }: { name: string; space: string; onCancel: () => void; onConfirm: (dontAsk: boolean) => void }) {
  const [dontAsk, setDontAsk] = useState(false);
  return (
    <Dialog title={`Share ${name} with everyone on termag?`} onClose={onCancel} className="fv-share-dialog">
      <p className="confirm-message">
        Anyone who can sign in to termag will be able to open and download this file from its link.
        They won't see the rest of {space} and can't change anything.
      </p>
      <label className="fv-share-skip">
        <input type="checkbox" checked={dontAsk} onChange={e => setDontAsk(e.target.checked)} />
        Don't ask again for files in {space}
      </label>
      <div className="confirm-actions">
        <button type="button" className="confirm-btn confirm-btn-cancel" onClick={onCancel}>Cancel</button>
        <button type="button" className="confirm-btn confirm-btn-primary" onClick={() => onConfirm(dontAsk)} autoFocus>Share file</button>
      </div>
    </Dialog>
  );
}

function ReloadIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path d="M13 8a5 5 0 1 1-1.5-3.6" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M12 1.8v3.1H8.9" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path d="M8 2v8M4.8 7 8 10.2 11.2 7" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M2.5 11v1.5a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V11" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

/**
 * The header's title: `space / folder / … / file` on one line, ending in the
 * file. Without room, folders from the space inward fold into one "…" whose
 * menu lists them (foldedCrumbs, measured on a hidden copy of the whole
 * path). A folder (or the space) opens Files in Tools with it open.
 */
function FileBreadcrumb({ space, path, revealDir, onFoldedWidth }: {
  space: string; path: string; revealDir?: (dir: string) => void;
  /** The width of `… / file`, the least this breadcrumb can show without cutting the name. */
  onFoldedWidth?: (px: number) => void;
}) {
  const crumbs = fileCrumbs(space, path);
  const navRef = useRef<HTMLElement>(null);
  const measureRef = useRef<HTMLOListElement>(null);
  const [folded, setFolded] = useState(0);
  const menu = useContextMenu();
  useLayoutEffect(() => {
    const nav = navRef.current;
    const measure = measureRef.current;
    if (!nav || !measure) return;
    const fit = () => {
      const widths = [...measure.children].map(el => Math.ceil(el.getBoundingClientRect().width));
      const ellipsis = widths.pop() ?? 0;
      setFolded(foldedCrumbs(widths, ellipsis, nav.clientWidth));
      onFoldedWidth?.(ellipsis + (widths[widths.length - 1] ?? 0));
    };
    fit();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(fit);
    ro.observe(nav);
    ro.observe(measure);
    return () => ro.disconnect();
  }, [space, path, !!revealDir]);

  const label = (c: (typeof crumbs)[number]) => c.dir == null ? (
    <span className="fv-crumb fv-crumb-current" aria-current="page" data-tip={`${space}/${path}`}>{c.label}</span>
  ) : revealDir ? (
    <button type="button" className="fv-crumb fv-crumb-link" data-tip={`Show ${c.dir || `${space}/`} in Files`} onClick={() => revealDir(c.dir)}>{c.label}</button>
  ) : (
    <span className="fv-crumb">{c.label}</span>
  );
  const sep = <span className="fv-crumb-sep" aria-hidden="true">/</span>;
  const cls = (i: number) => i === 0 ? 'fv-crumb-space' : i === crumbs.length - 1 ? 'fv-crumb-file' : 'fv-crumb-dir';
  const spaceFolded = folded >= crumbs.length - 1;
  const hidden = spaceFolded ? crumbs.slice(0, -1) : crumbs.slice(1, 1 + folded);
  const hiddenNames = hidden.map(c => c.label).join(' / ');
  const openHidden = (e: MenuTrigger) => menu.open(e, 'Hidden folders', hidden.map(c => ({ label: c.label, onSelect: () => revealDir?.(c.dir ?? '') })));
  const start = spaceFolded ? crumbs.length - 1 : 1 + folded;
  return (
    <nav ref={navRef} className="fv-crumbs" aria-label="File path">
      <ol>
        {!spaceFolded && <li className={cls(0)}>{label(crumbs[0])}</li>}
        {folded > 0 && (
          <li className="fv-crumb-fold">
            {!spaceFolded && sep}
            {revealDir ? (
              <button type="button" className="fv-crumb fv-crumb-link fv-crumb-more" aria-haspopup="menu"
                aria-label={`More of the path: ${hiddenNames}`}
                data-tip={hiddenNames}
                onPointerDown={e => { e.currentTarget.dataset.pointer = e.pointerType; }}
                onClick={e => openHidden(e)} onKeyDown={menuButtonKeys(e => openHidden(e))}>…</button>
            ) : (
              <span className="fv-crumb"><span aria-hidden="true">…</span><span className="chat-sr">{hiddenNames}</span></span>
            )}
          </li>
        )}
        {crumbs.slice(start).map((c, j) => {
          const i = start + j;
          return <li key={i} className={cls(i)}>{sep}{label(c)}</li>;
        })}
      </ol>
      <ol ref={measureRef} className="fv-crumbs-measure" aria-hidden="true">
        {crumbs.map((c, i) => (
          <li key={i} className={cls(i)}>
            {i > 0 && sep}
            <span className={`fv-crumb${c.dir == null ? ' fv-crumb-current' : revealDir ? ' fv-crumb-link' : ''}`}>{c.label}</span>
          </li>
        ))}
        <li className="fv-crumb-fold">{sep}<span className={`fv-crumb${revealDir ? ' fv-crumb-link fv-crumb-more' : ''}`}>…</span></li>
      </ol>
      {menu.menu}
    </nav>
  );
}

export function SpaceFileView() {
  const params = useParams();
  const space = params.space ?? '';
  const path = params['*'] ?? '';
  const navigate = useNavigate();
  const { search } = useLocation();
  // The tab showing this file (the route's ?tab=, or the one the route opened for a pasted link): a folder takes it over.
  const routeActiveTab = useSimpleDataIfAny()?.activeTab ?? null;
  const tabShown = tabForRoute(search) ?? routeActiveTab;
  const tabRef = useRef(tabShown);
  tabRef.current = tabShown;
  const [loaded, setLoadedNow] = useState<Loaded>({ state: 'loading' });
  const [copied, setCopied] = useState(false);
  const [reloads, setReloads] = useState(0);
  // The file's sharing as the server last said, and whether the viewer reached the space through a share
  // (not a member). Each is kept with what it was read for, so another file or space shows neither until it loads.
  const [shareFor, setShareFor] = useState<{ space: string; path: string; state: ShareState | null } | null>(null);
  const [accessFor, setAccessFor] = useState<{ space: string; viaShare: boolean } | null>(null);
  const share = shareFor?.space === space && shareFor.path === path ? shareFor.state : null;
  const known = accessFor?.space === space;
  const viaShare = known && accessFor.viaShare;
  const member = known && !accessFor.viaShare;
  // The Share confirmation, kept with the file it asks about: opening another file drops it rather than share that one.
  const [confirmFor, setConfirmFor] = useState<{ space: string; path: string } | null>(null);
  const confirming = confirmFor?.space === space && confirmFor.path === path;
  const [shareBusy, setShareBusy] = useState(false);
  const [shareError, setShareError] = useState<string | null>(null);
  const { sidePanel } = useChatChrome();
  const coarse = useCoarsePointer();
  const more = useContextMenu();
  // Too narrow for the buttons beside `… / file` (Tools open at 1024px, say): the phone's ⋮ layout.
  // Measured on the header itself, not the viewport; the buttons stay laid out (unseen) to be measured.
  const headerRef = useRef<HTMLElement>(null);
  const titleRef = useRef<HTMLDivElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  const wideRef = useRef<HTMLSpanElement>(null);
  const [foldedWidth, setFoldedWidth] = useState(0);
  const [compact, setCompact] = useState(false);
  useLayoutEffect(() => {
    const header = headerRef.current;
    const title = titleRef.current;
    const wide = wideRef.current;
    if (!header || !title || !wide) return;
    const fit = () => {
      if (!header.clientWidth) return;
      const width = (el: Element) => el.getBoundingClientRect().width;
      const hs = getComputedStyle(header);
      const gap = parseFloat(hs.columnGap) || 0;
      let room = header.clientWidth - (parseFloat(hs.paddingLeft) || 0) - (parseFloat(hs.paddingRight) || 0) - gap;
      for (const el of header.children) {
        if (el !== title && el !== actionsRef.current && width(el) > 0) room -= width(el) + gap;
      }
      const titleGap = parseFloat(getComputedStyle(title).columnGap) || 0;
      for (const el of title.children) {
        if (!el.classList.contains('fv-crumbs') && width(el) > 0) room -= width(el) + titleGap;
      }
      setCompact(headerNeedsMenu(room, Math.ceil(width(wide)), foldedWidth));
    };
    fit();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(fit);
    ro.observe(header);
    ro.observe(wide);
    return () => ro.disconnect();
  }, [foldedWidth, member, share]);
  // A change to this file reloads it in place (SpaceFileLive.tsx).
  const live = useSpaceFileLive<Loaded>({ space, path, loaded, setLoaded: setLoadedNow, reload: () => setReloads(n => n + 1), gone: { state: 'gone' } });
  const setLoaded = live.setLoaded;
  // Another file drops the Share confirmation for good, so coming back doesn't reopen it; a live reload in place keeps it.
  useEffect(() => { setConfirmFor(null); }, [space, path]);

  useEffect(() => {
    let cancelled = false;
    let viaLink = false;
    setLoaded({ state: 'loading' });
    setShareError(null);
    (async () => {
      let signed: SpaceViewUrl;
      let shared = false;
      try {
        signed = await spacesApi.view(space, path);
      } catch (err) {
        // Not a member (or no such space): the file may still be shared with termag.
        const r = (err as { response?: { data?: { code?: string }; status?: number } })?.response;
        if (r?.data?.code === 'file_not_found' && !cancelled) setAccessFor({ space, viaShare: false });
        if (r?.status !== 404 || r.data?.code === 'file_not_found') throw err;
        viaLink = true;
        signed = await spacesApi.sharedView(space, path);
        shared = true;
      }
      if (cancelled) return;
      setAccessFor({ space, viaShare: shared });
      setShareFor({ space, path, state: signed.share ?? null });
      const show = fileShow(signed.view);
      const type = signed.view?.contentType ?? '';
      if (!fetchesText(show, type)) {
        if (!cancelled) setLoaded({ state: 'ok', url: signed.url, size: signed.size, type, show });
        return;
      }
      const max = showsAsCode(show, type) ? CODE_VIEW_MAX_BYTES : TEXT_PREVIEW_MAX_BYTES;
      const capped = signed.size > max;
      const res = await fetch(signed.url, capped ? { headers: { Range: `bytes=0-${max - 1}` } } : {});
      if (!res.ok && res.status !== 206) throw new Error(`The file could not be read (${res.status})`);
      const text = await res.text();
      if (!cancelled) setLoaded({ state: 'ok', url: signed.url, size: signed.size, type, show, text, truncated: capped });
    })().catch(async err => {
      if (cancelled) return;
      const code = (err as { response?: { data?: { code?: string }; status?: number } })?.response;
      if (code?.data?.code === 'file_not_found' || code?.status === 404) {
        // A member's path with no file may be a folder: shown in the explorer, in this tab.
        const folder = !viaLink && await spacesApi.tree(space, `${path}/`)
          .then(t => t.dirs.length > 0 || t.files.length > 0, () => false);
        if (cancelled) return;
        if (folder) navigate(folderHref(space, `${path}/`, tabRef.current), { replace: true });
        else setLoaded({ state: 'gone', notShared: viaLink });
      } else setLoaded({ state: 'error', text: errorMessage(err, 'Could not open the file') });
    });
    return () => { cancelled = true; };
  }, [space, path, reloads]);

  const copyLink = () => {
    navigator.clipboard?.writeText(spaceFileLink(window.location.origin, import.meta.env.BASE_URL, space, path)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  };
  const download = () => { void downloadFile(space, path).catch(() => {}); };

  const shared = share?.shared === true;
  const canShare = share?.canShare === true && member && loaded.state !== 'gone';
  const setSharing = async (on: boolean) => {
    setShareBusy(true);
    setShareError(null);
    try {
      const next = on ? await spacesApi.share(space, path) : await spacesApi.unshare(space, path);
      setShareFor(s => s?.space === space && s.path === path ? { space, path, state: { ...next, canShare: s.state?.canShare ?? true } } : s);
      announceShared(space, path, next.shared);
    } catch (err) {
      setShareError(errorMessage(err, on ? 'Could not share the file' : 'Could not make the file private'));
    } finally {
      setShareBusy(false);
    }
  };
  const toggleShare = () => {
    if (shareBusy) return;
    if (shared) { void setSharing(false); return; }
    if (skipsShareConfirm(localStore(), space)) { void setSharing(true); return; }
    setConfirmFor({ space, path });
  };
  const copyLabel = copied ? 'Link copied' : `Copy link (${linkAudience(shared || viaShare)})`;

  const name = path.slice(path.lastIndexOf('/') + 1);
  const show = loaded.state === 'ok' ? loaded.show : null;
  const media = loaded.state === 'ok' && show?.kind === 'frame' ? loaded.type.split('/')[0] : null;
  const code = loaded.state === 'ok' && show != null && showsAsCode(show, loaded.type) && loaded.text !== undefined;
  const pdfOutside = loaded.state === 'ok' && show?.kind === 'frame' && loaded.type === 'application/pdf'
    && (coarse || (navigator as { pdfViewerEnabled?: boolean }).pdfViewerEnabled === false);
  const openMore = (e: MenuTrigger) => more.open(e, `${name}: more`, [
    { label: 'Reload', onSelect: () => setReloads(n => n + 1) },
    ...(member ? [{ label: 'Download', disabled: loaded.state === 'gone', onSelect: download }] : []),
    ...(canShare ? [{ label: shared ? 'Make private' : 'Share with termag users…', disabled: shareBusy, onSelect: toggleShare }] : []),
    { label: copied ? 'Link copied' : 'Copy link', onSelect: copyLink },
    ...(sidePanel && member ? [{ label: sidePanel.open ? 'Hide tools' : 'Show tools', onSelect: sidePanel.toggle }] : []),
  ]);

  return (
    <div className="chat-view">
      <section className="chat-conv">
        <LiveCue space={space} cue={live.cue} onReload={live.applyPending} />
        <header ref={headerRef} className="chat-header fv-header" data-compact={compact || undefined}>
          <CloseAndBackButton />
          <ChatHistoryButton />
          <div ref={titleRef} className="chat-title">
            <FileBreadcrumb space={space} path={path} revealDir={member ? sidePanel?.revealDir : undefined} onFoldedWidth={setFoldedWidth} />
            {viaShare && share?.shared && (
              <span className="fv-shared-by">Shared by {share.sharedBy?.displayName ?? 'someone who left termag'}</span>
            )}
          </div>
          <div ref={actionsRef} className="chat-header-actions">
            <span ref={wideRef} className="fv-wide-group">
              <button type="button" className="btn-ghost fv-icon-btn fv-reload" aria-label="Reload" data-tip="Reload (signs a fresh link)" onClick={() => setReloads(n => n + 1)}>
                <ReloadIcon />
              </button>
              {member && (
                <button type="button" className="btn-ghost fv-icon-btn fv-download" aria-label="Download" data-tip={`Download ${name}`}
                  disabled={loaded.state === 'gone'} onClick={download}>
                  <DownloadIcon />
                </button>
              )}
              <div className="fv-share" role="group" aria-label="Sharing">
                {canShare && (
                  <button type="button" className="btn-ghost fv-share-main" aria-pressed={shared} disabled={shareBusy}
                    data-tip={shared ? 'Anyone signed in to termag can view. Click to make private' : 'Let anyone signed in to termag view this file'}
                    onClick={toggleShare}>
                    {shared ? <PeopleIcon /> : <LockIcon />}
                    <span>{shared ? 'Shared' : 'Share'}</span>
                  </button>
                )}
                <button type="button" className={`btn-ghost fv-share-link${canShare ? '' : ' alone'}`} aria-label={copyLabel} data-tip={copyLabel} onClick={copyLink}>
                  <LinkIcon />
                  {!canShare && <span>{copied ? 'Copied' : 'Copy link'}</span>}
                </button>
                <span className="chat-sr" role="status">{copied ? 'Link copied' : ''}</span>
              </div>
              {sidePanel && member && <span className="fv-tools"><SidePanelButton /></span>}
            </span>
            <button type="button" className="btn-ghost fv-more" aria-label="More" aria-haspopup="menu"
              onPointerDown={e => { e.currentTarget.dataset.pointer = e.pointerType; }}
              onClick={openMore} onKeyDown={menuButtonKeys(openMore)}>
              <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
                <circle cx="8" cy="3.5" r="1.4" fill="currentColor" /><circle cx="8" cy="8" r="1.4" fill="currentColor" /><circle cx="8" cy="12.5" r="1.4" fill="currentColor" />
              </svg>
            </button>
            {more.menu}
          </div>
        </header>
        {shareError && <div className="fv-note fv-share-error" role="alert">{shareError}</div>}
        {confirming && (
          <ShareConfirm name={name} space={space} onCancel={() => setConfirmFor(null)}
            onConfirm={dontAsk => {
              if (dontAsk) skipShareConfirm(localStore(), space);
              setConfirmFor(null);
              void setSharing(true);
            }} />
        )}
        {pdfOutside && loaded.state === 'ok' ? (
          <div className="chat-transcript">
            <div className="chat-transcript-inner fv" data-kind="pdf">
              <div className="chat-empty fv-open">
                <p>{name} · {formatBytes(loaded.size)}. This browser can't show a PDF inside the page.</p>
                <a className="btn-primary fv-open-btn" href={loaded.url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">Open PDF</a>
                {member && <button type="button" className="btn-ghost fv-open-btn" onClick={download}>Download</button>}
              </div>
            </div>
          </div>
        ) : loaded.state === 'ok' && media === 'image' ? (
          <div className={`fv-media fv-image ${REPLAY_BLOCK_CLASS}`}>
            <img key={loaded.url} src={loaded.url} alt={name} referrerPolicy="no-referrer" />
          </div>
        ) : loaded.state === 'ok' && (media === 'video' || media === 'audio') ? (
          <div className={`fv-media ${REPLAY_BLOCK_CLASS}`}>
            {media === 'video'
              ? <video key={loaded.url} src={loaded.url} controls playsInline preload="metadata" aria-label={name} />
              : <audio key={loaded.url} src={loaded.url} controls preload="metadata" aria-label={name} />}
          </div>
        ) : code && loaded.state === 'ok' ? (
          <div className={`fv-code ${REPLAY_BLOCK_CLASS}`}>
            {isMermaidPath(path) && !loaded.truncated ? <MermaidBlock file source={loaded.text ?? ''} name={name} /> : (
              <CodeView path={path} text={loaded.text ?? ''}
                note={loaded.truncated ? `showing the first ${formatBytes(CODE_VIEW_MAX_BYTES)} of ${formatBytes(loaded.size)}; download for the rest` : null} />
            )}
          </div>
        ) : loaded.state === 'ok' && show?.kind === 'frame' ? (
          <iframe
            key={loaded.url}
            className={`fv-frame ${REPLAY_BLOCK_CLASS}`}
            title={name}
            src={loaded.url}
            referrerPolicy="no-referrer"
          />
        ) : loaded.state === 'ok' && show?.kind === 'html' && loaded.text !== undefined ? (
          <>
            {loaded.truncated && <div className="fv-note fv-html-note">Showing the first {formatBytes(TEXT_PREVIEW_MAX_BYTES)} of {formatBytes(loaded.size)}; download for the rest.</div>}
            <iframe
              key={loaded.url}
              className={`fv-frame fv-html ${REPLAY_BLOCK_CLASS}`}
              title={name}
              sandbox=""
              srcDoc={loaded.text}
              referrerPolicy="no-referrer"
            />
          </>
        ) : (
          <div className="chat-transcript">
            <div className={`chat-transcript-inner fv ${REPLAY_BLOCK_CLASS}`} data-kind={show?.kind ?? loaded.state}>
              {loaded.state === 'loading' && <div className="chat-empty">Loading…</div>}
              {loaded.state === 'gone' && <div className="chat-empty">{loaded.notShared
                ? 'This file isn\'t shared with you. It may have been made private, moved or deleted.'
                : <>This file is gone from {space}. Close its tab from the ⋮ menu.</>}</div>}
              {loaded.state === 'error' && <div className="chat-archived-error" role="alert">{loaded.text}</div>}
              {loaded.state === 'ok' && show?.kind === 'markdown' && loaded.text !== undefined && (
                <div className="fv-md sdk-text"><FileComposeLinks space={space}>
                  <SpaceMarkdownImages space={space} path={path} viaShare={viaShare}><Markdown text={loaded.text} /></SpaceMarkdownImages>
                </FileComposeLinks></div>
              )}
              {loaded.state === 'ok' && show?.kind === 'svg' && loaded.text !== undefined && (
                <div className="fv-svg">{loaded.truncated
                  ? <div className="chat-empty">This SVG is over {formatBytes(TEXT_PREVIEW_MAX_BYTES)}; download it to see it.</div>
                  : <img src={svgDataUrl(loaded.text)} alt={name} />}</div>
              )}
              {loaded.state === 'ok' && show?.kind === 'download' && (
                <div className="chat-empty">
                  {formatBytes(loaded.size)}. Your browser can't show this kind of file.{' '}
                  {member && <button type="button" className="btn-tiny" onClick={download}>Download</button>}
                </div>
              )}
              {loaded.state === 'ok' && loaded.truncated && show?.kind !== 'svg' && <div className="fv-note">Showing the first {formatBytes(TEXT_PREVIEW_MAX_BYTES)} of {formatBytes(loaded.size)}; download for the rest.</div>}
            </div>
          </div>
        )}
        <SpaceFileChat space={space} path={path} />
      </section>
    </div>
  );
}
