// One space file in the simple UI's main pane (/chat/f/<space>/<path>,
// simple-ui-side-panel-enabled), opened from the file explorer, the sidebar
// or a space link in a reply. The server signs a 30-minute presigned S3 URL
// and says how to show it. PDFs and text:
// the URL is the src of an unsandboxed iframe and the browser's own viewer
// renders it. Images are an <img> scaled to fit (a phone's frame shows one
// at full size, cut off), and video and audio the browser's player, inline
// (an iframe of a video goes full screen on an iPhone). A touch screen gets
// an Open PDF button instead of a framed PDF: iOS Safari draws only the
// first page in a frame and Android Chrome draws nothing. Markdown, HTML and SVG are signed as
// plain text and fetched: Markdown is rendered by the chat's renderer (text
// only, no HTML, images linked, not fetched), HTML is the srcdoc of an iframe
// sandboxed with no allowances (no scripts, an opaque origin), SVG is a data:
// URL in an <img>. Types the browser can't show are a download. The space's
// explorer is the side panel's Files tab, and Tools opens it. A file picked
// in the explorer replaces this one in the same tab. On a phone Reload, Copy link and Download are under ⋮, as an
// agent's actions are.
import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { spacesApi } from '../../services/api';
import { downloadFile, errorMessage } from '../../services/spaceTransfer';
import { formatBytes, spaceFileLink, TEXT_PREVIEW_MAX_BYTES } from '../../utils/spaces';
import { Markdown } from '../../chat/Markdown';
import { fetchesText, fileShow, svgDataUrl, type FileShow } from '../../chat/fileExplorer';
import { REPLAY_BLOCK_CLASS } from '../../observability';
import { ChatHistoryButton, SidePanelButton, useChatChrome } from './chatChrome';
import { useCoarsePointer, useContextMenu } from './ContextMenu';

type Loaded =
  | { state: 'loading' }
  | { state: 'gone' }
  | { state: 'error'; text: string }
  | { state: 'ok'; url: string; size: number; type: string; show: FileShow; text?: string; truncated?: boolean };

export function SpaceFileView() {
  const params = useParams();
  const space = params.space ?? '';
  const path = params['*'] ?? '';
  const [loaded, setLoaded] = useState<Loaded>({ state: 'loading' });
  const [copied, setCopied] = useState(false);
  const [reloads, setReloads] = useState(0);
  const { sidePanel } = useChatChrome();
  const coarse = useCoarsePointer();
  const more = useContextMenu();

  useEffect(() => {
    let cancelled = false;
    setLoaded({ state: 'loading' });
    (async () => {
      const signed = await spacesApi.view(space, path);
      const show = fileShow(signed.view);
      const type = signed.view?.contentType ?? '';
      if (!fetchesText(show)) {
        if (!cancelled) setLoaded({ state: 'ok', url: signed.url, size: signed.size, type, show });
        return;
      }
      const capped = signed.size > TEXT_PREVIEW_MAX_BYTES;
      const res = await fetch(signed.url, capped ? { headers: { Range: `bytes=0-${TEXT_PREVIEW_MAX_BYTES - 1}` } } : {});
      if (!res.ok && res.status !== 206) throw new Error(`The file could not be read (${res.status})`);
      const text = await res.text();
      if (!cancelled) setLoaded({ state: 'ok', url: signed.url, size: signed.size, type, show, text, truncated: capped });
    })().catch(err => {
      if (cancelled) return;
      const code = (err as { response?: { data?: { code?: string }; status?: number } })?.response;
      if (code?.data?.code === 'file_not_found' || code?.status === 404) setLoaded({ state: 'gone' });
      else setLoaded({ state: 'error', text: errorMessage(err, 'Could not open the file') });
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

  const name = path.slice(path.lastIndexOf('/') + 1);
  const show = loaded.state === 'ok' ? loaded.show : null;
  const media = loaded.state === 'ok' && show?.kind === 'frame' ? loaded.type.split('/')[0] : null;
  const pdfOutside = loaded.state === 'ok' && show?.kind === 'frame' && loaded.type === 'application/pdf'
    && (coarse || (navigator as { pdfViewerEnabled?: boolean }).pdfViewerEnabled === false);

  return (
    <div className="chat-view">
      <section className="chat-conv">
        <header className="chat-header fv-header">
          <ChatHistoryButton />
          <div className="chat-title" data-tip={`${space}:${path}`}>
            <span className="chat-title-name">{name}</span>
            <span className="chat-title-repo">{space}:{path}</span>
          </div>
          <div className="chat-header-actions">
            {sidePanel && <span className="fv-wide fv-tools"><SidePanelButton /></span>}
            <button type="button" className="btn-ghost fv-wide" data-tip="Sign a fresh link and reload" onClick={() => setReloads(n => n + 1)}>Reload</button>
            <button type="button" className="btn-ghost fv-wide" onClick={copyLink}>{copied ? 'Copied' : 'Copy link'}</button>
            <button type="button" className="btn-ghost fv-wide" disabled={loaded.state === 'gone'} onClick={download}>Download</button>
            <button type="button" className="btn-ghost fv-more" aria-label="More" aria-haspopup="menu"
              onPointerDown={e => { e.currentTarget.dataset.pointer = e.pointerType; }}
              onClick={e => more.open(e, `${name}: more`, [
                { label: 'Reload', onSelect: () => setReloads(n => n + 1) },
                { label: copied ? 'Copied' : 'Copy link', onSelect: copyLink },
                { label: 'Download', disabled: loaded.state === 'gone', onSelect: download },
                ...(sidePanel ? [{ label: sidePanel.open ? 'Hide tools' : 'Show tools', onSelect: sidePanel.toggle }] : []),
              ])}>
              <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
                <circle cx="8" cy="3.5" r="1.4" fill="currentColor" /><circle cx="8" cy="8" r="1.4" fill="currentColor" /><circle cx="8" cy="12.5" r="1.4" fill="currentColor" />
              </svg>
            </button>
            {more.menu}
          </div>
        </header>
        {pdfOutside && loaded.state === 'ok' ? (
          <div className="chat-transcript">
            <div className="chat-transcript-inner fv" data-kind="pdf">
              <div className="chat-empty fv-open">
                <p>{name} · {formatBytes(loaded.size)}. This browser can't show a PDF inside the page.</p>
                <a className="btn-primary fv-open-btn" href={loaded.url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">Open PDF</a>
                <button type="button" className="btn-ghost fv-open-btn" onClick={download}>Download</button>
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
              {loaded.state === 'gone' && <div className="chat-empty">This file is gone from {space}. Close its tab from the ⋮ menu.</div>}
              {loaded.state === 'error' && <div className="chat-archived-error" role="alert">{loaded.text}</div>}
              {loaded.state === 'ok' && show?.kind === 'markdown' && loaded.text !== undefined && (
                <div className="fv-md sdk-text"><Markdown text={loaded.text} /></div>
              )}
              {loaded.state === 'ok' && show?.kind === 'svg' && loaded.text !== undefined && (
                <div className="fv-svg">{loaded.truncated
                  ? <div className="chat-empty">This SVG is over {formatBytes(TEXT_PREVIEW_MAX_BYTES)}; download it to see it.</div>
                  : <img src={svgDataUrl(loaded.text)} alt={name} />}</div>
              )}
              {loaded.state === 'ok' && show?.kind === 'download' && (
                <div className="chat-empty">
                  {formatBytes(loaded.size)}. Your browser can't show this kind of file.{' '}
                  <button type="button" className="btn-tiny" onClick={download}>Download</button>
                </div>
              )}
              {loaded.state === 'ok' && loaded.truncated && show?.kind !== 'svg' && <div className="fv-note">Showing the first {formatBytes(TEXT_PREVIEW_MAX_BYTES)} of {formatBytes(loaded.size)}; download for the rest.</div>}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
