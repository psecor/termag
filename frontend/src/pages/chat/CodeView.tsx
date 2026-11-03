// A text or code file in the file view (SpaceFileView), read-only: line
// numbers, highlight.js colours in the app's palette (chat/highlight.ts loads
// it on first use), and a wrap toggle, off for code by default. Text too big
// to highlight, or with no grammar, is shown plain. The wrap choice is kept
// per kind (code, text) in localStorage.
import React, { useEffect, useMemo, useState } from 'react';
import { highlightable, languageFor, splitHighlightedLines, textLines, wrapsByDefault } from '../../chat/codeView';
import { highlight } from '../../chat/highlight';

const WRAP_KEY = 'termag.fileView.wrap.';

function readWrap(kind: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(WRAP_KEY + kind);
    return v === null ? fallback : v === '1';
  } catch {
    return fallback;
  }
}

export function CodeView({ path, text, note }: { path: string; text: string; note?: string | null }) {
  const language = languageFor(path);
  const kind = language ? 'code' : 'text';
  const tooBig = language != null && !highlightable(text);
  const [wrap, setWrap] = useState(() => readWrap(kind, wrapsByDefault(path)));
  const [html, setHtml] = useState<string[] | null>(null);
  const plain = useMemo(() => textLines(text), [text]);

  useEffect(() => { setWrap(readWrap(kind, wrapsByDefault(path))); }, [kind, path]);
  useEffect(() => {
    setHtml(null);
    if (!language || tooBig) return;
    let cancelled = false;
    highlight(text, language)
      .then(h => { if (!cancelled && h !== null) setHtml(splitHighlightedLines(h)); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [text, language, tooBig]);

  const toggleWrap = () => {
    const next = !wrap;
    setWrap(next);
    try { localStorage.setItem(WRAP_KEY + kind, next ? '1' : '0'); } catch { /* private mode */ }
  };

  const lines = html ?? plain;
  const count = plain.length;
  return (
    <div className="cv" data-wrap={wrap ? 'on' : 'off'}>
      <div className="cv-bar">
        <span className="cv-meta">
          {count.toLocaleString()} {count === 1 ? 'line' : 'lines'}
          {tooBig ? ' · too large to highlight' : ''}
          {note ? ` · ${note}` : ''}
        </span>
        <button type="button" className="btn-tiny cv-wrap" aria-pressed={wrap} onClick={toggleWrap}>
          {wrap ? 'Wrap: on' : 'Wrap: off'}
        </button>
      </div>
      <div className="cv-scroll" tabIndex={0} role="region" aria-label={`${path.slice(path.lastIndexOf('/') + 1)} contents`}>
        <div className="cv-lines" style={{ '--cv-gutter': `${String(count).length + 1}ch` } as React.CSSProperties}>
          {lines.map((line, i) => (
            <div className="cv-line" key={i}>
              <span className="cv-num" aria-hidden="true">{i + 1}</span>
              {html
                ? <span className="cv-code" dangerouslySetInnerHTML={{ __html: line }} />
                : <span className="cv-code">{line}</span>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
