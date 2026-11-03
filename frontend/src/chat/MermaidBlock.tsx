// Where a Mermaid diagram goes in a reply, a Markdown file, the pane chat or
// the file view. MermaidDiagram, and Mermaid with it, load the first time one
// renders (chat/mermaid.ts), so a page with no diagram never fetches either.
import React, { Suspense, lazy } from 'react';
import './mermaid.css';

const MermaidDiagram = lazy(() => import('./MermaidDiagram'));

/** `file`: a whole .mmd file, filling the file view; else a block in flowing text. */
export function MermaidBlock({ source, name, file = false }: { source: string; name?: string; file?: boolean }) {
  return (
    <Suspense fallback={<div className={file ? 'mmd mmd-file' : 'mmd'} data-state="drawing"><div className="mmd-drawing">Drawing diagram…</div></div>}>
      <MermaidDiagram source={source} name={name} file={file} />
    </Suspense>
  );
}
