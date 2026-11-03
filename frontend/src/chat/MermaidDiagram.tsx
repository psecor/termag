// One Mermaid diagram (chat/mermaid.ts): a reply's or a Markdown file's
// ```mermaid fence, or a whole .mmd / .mermaid file in the file view. Loaded
// through MermaidBlock (React.lazy), so neither this nor Mermaid is in a
// bundle until a diagram shows.
//
// The diagram is drawn in a sandboxed frame (mermaid.ts diagramDocument says
// why that is safe) with svg-pan-zoom and Hammer.js, and no visible controls
// (mermaid.ts frameScript has the gestures). A whole file is always live. A
// diagram in a reply or a Markdown file is a plain picture the page scrolls
// past until it is clicked, tapped or given Enter; while it is active its
// border is the accent colour, and a click elsewhere, Escape or a scroll of
// the page makes it a picture again. The frame takes the box's width at the
// diagram's aspect, never taller than the diagram itself or min(70vh,
// 720px), so a wide diagram starts fitted to the width. It is drawn in the
// page's theme and drawn again (a new frame) when that changes. "View source" shows the text instead; a
// diagram Mermaid can't draw shows its source with Mermaid's error in a line.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Button, ToggleButton } from '@launchpad-ui/components';
import { LP_THEME } from '../launchpad/theme';
import {
  diagramDocument, diagramError, diagramKind, FRAME_MESSAGE, FRAME_START_GRACE_MS, newNonce, readDiagramTheme, renderMermaid, themeKey, type DiagramTheme, type RenderedDiagram,
} from './mermaid';
import './mermaid.css';

type Drawn =
  | { state: 'drawing' }
  | { state: 'ok'; image: RenderedDiagram; source: string }
  | { state: 'error'; message: string };

/**
 * The page's diagram theme, read again when <html>'s style or class changes
 * (ThemeProvider writes its variables there) or the OS scheme flips.
 */
export function useDiagramTheme(): DiagramTheme {
  const [theme, setTheme] = useState(() => readDiagramTheme());
  useEffect(() => {
    const update = () => setTheme(prev => {
      const next = readDiagramTheme();
      return themeKey(next) === themeKey(prev) ? prev : next;
    });
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class', 'data-theme'] });
    const media = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null;
    media?.addEventListener?.('change', update);
    update();
    return () => { observer.disconnect(); media?.removeEventListener?.('change', update); };
  }, []);
  return theme;
}

/** Room around a diagram in its frame, so a fitted diagram doesn't touch the border. */
const FRAME_PAD = 16;

/**
 * The frame's size: never wider than the diagram at its own size (so the fit
 * never enlarges it). In a reply or a Markdown file, the box's width at its
 * aspect when it is wider (`cqw`, .mmd is the container), plus a little room,
 * capped by the view. A whole file's frame takes the file pane's
 * height from CSS (`.mmd-file .mmd-frame`, a flex child): a height from the
 * window could outgrow the pane, and the box would cut the diagram off.
 */
export function frameStyle(image: { width: number; height: number }, file: boolean): React.CSSProperties | undefined {
  const { width: w, height: h } = image;
  if (!w || !h) return undefined;
  const width = `min(100%, ${Math.max(w, 220)}px)`;
  if (file) return { width };
  return {
    width,
    height: `calc(min(100cqw * ${(h / w).toFixed(4)}, ${h}px) + ${FRAME_PAD}px)`,
    maxHeight: 'min(70vh, 720px)',
  };
}

export default function MermaidDiagram({ source, name, file = false }: { source: string; name?: string; file?: boolean }) {
  const theme = useDiagramTheme();
  const key = themeKey(theme);
  const [drawn, setDrawn] = useState<Drawn>({ state: 'drawing' });
  const [showSource, setShowSource] = useState(false);
  const [copied, setCopied] = useState(false);
  const kind = diagramKind(source);
  const frame = useRef<HTMLIFrameElement>(null);
  const [active, setActive] = useState(false);
  const image = drawn.state === 'ok' ? drawn.image : null;
  const doc = useMemo(
    () => (image ? diagramDocument(image.svg, image.theme, image.scripts, newNonce(), file ? 'file' : 'embed') : null),
    [image, file],
  );

  // A new frame starts inactive, and hasn't said yet whether it drew.
  const heard = useRef(false);
  const [loaded, setLoaded] = useState(0);
  useEffect(() => { setActive(false); heard.current = false; }, [doc]);
  // The frame says when it becomes active or not, and whether it drew; only
  // its own window is listened to. A frame that fails, or loads and says
  // nothing at all (its script never ran), shows the source and the error
  // rather than an empty box.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!frame.current || e.source !== frame.current.contentWindow) return;
      const data = e.data as Record<string, unknown> | null;
      const what = data?.[FRAME_MESSAGE];
      if (what === 'waiting' || what === 'drawn' || what === 'failed') heard.current = true;
      if (what === 'active' && !file) setActive(data!.active === true);
      if (what === 'failed') setDrawn({ state: 'error', message: diagramError(typeof data!.message === 'string' && data!.message ? data!.message : 'its frame could not draw it') });
    };
    addEventListener('message', onMessage);
    return () => removeEventListener('message', onMessage);
  }, [file]);
  useEffect(() => {
    if (!loaded || heard.current) return;
    const timer = setTimeout(() => {
      if (!heard.current) setDrawn({ state: 'error', message: 'its frame did not start, so it can\'t be shown.' });
    }, FRAME_START_GRACE_MS);
    return () => clearTimeout(timer);
  }, [loaded]);
  // While active: Escape on the page, a press outside the frame or the page
  // scrolling away makes it a picture again.
  useEffect(() => {
    if (!active) return;
    const off = () => frame.current?.contentWindow?.postMessage({ [FRAME_MESSAGE]: 'deactivate' }, '*');
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') off(); };
    const onDown = (e: PointerEvent) => { if (e.target !== frame.current) off(); };
    addEventListener('keydown', onKey);
    addEventListener('pointerdown', onDown, true);
    addEventListener('scroll', off, true);
    return () => {
      removeEventListener('keydown', onKey);
      removeEventListener('pointerdown', onDown, true);
      removeEventListener('scroll', off, true);
    };
  }, [active]);

  useEffect(() => {
    let cancelled = false;
    // A theme change keeps the old picture up until the new one is ready; a
    // new source never shows the old one.
    setDrawn(d => (d.state === 'ok' && d.source === source ? d : { state: 'drawing' }));
    renderMermaid(source, theme)
      .then(image => { if (!cancelled) setDrawn({ state: 'ok', image, source }); })
      .catch(err => { if (!cancelled) setDrawn({ state: 'error', message: diagramError(err) }); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` is the theme's identity
  }, [source, key]);

  const copy = () => {
    navigator.clipboard?.writeText(source).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  };

  const failed = drawn.state === 'error';
  const label = `${kind ?? 'Mermaid'} diagram${name ? `: ${name}` : ''}`;
  return (
    <div className={`mmd ${file ? 'mmd-file ' : ''}${LP_THEME}`} data-state={drawn.state} data-kind={kind ?? undefined} data-active={active || undefined}>
      <div className="mmd-head">
        <span className="mmd-kind">{kind ?? 'mermaid'}</span>
        {failed && <span className="mmd-error" role="alert">Couldn't draw this diagram: {drawn.message}</span>}
        <span className="mmd-actions">
          {!failed && (
            <ToggleButton size="small" isSelected={showSource} onChange={setShowSource}>View source</ToggleButton>
          )}
          <Button size="small" variant="minimal" onPress={copy}>{copied ? 'Copied' : 'Copy'}</Button>
        </span>
      </div>
      {failed || showSource ? (
        <pre className="mmd-source"><code>{source}</code></pre>
      ) : drawn.state === 'ok' && doc ? (
        <iframe
          ref={frame}
          className="mmd-frame"
          title={file ? label : `${label}. Click or press Enter to zoom and pan, Escape to stop.`}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          srcDoc={doc}
          onLoad={() => setLoaded(n => n + 1)}
          style={frameStyle(drawn.image, file)}
        />
      ) : (
        <div className="mmd-drawing">Drawing diagram…</div>
      )}
    </div>
  );
}
