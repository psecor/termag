// A reply's markdown (chat/markdownParse.ts) as React elements. Text only: no
// HTML is ever interpreted (a `<details>` the parser read becomes a native,
// attribute-free <details>, open only if the source said so), links are http(s) or mailto and open in a new
// tab, and an image is a link to it, never fetched (a space file's view may draw its own,
// MarkdownImageContext). A closed ```mermaid fence is a diagram (MermaidBlock);
// one still streaming stays code until its closing fence arrives.
import React, { createContext, useContext, useState } from 'react';
import { CodeFenceContext, type CodeFence } from './codeFence';
import { MermaidBlock } from './MermaidBlock';
import { isMermaidFence } from './mermaidFence';
import { parseMarkdown, type Inline, type MdBlock, type MdItem } from './markdownParse';

/**
 * A plain click on a link asks this first; true means it was opened in place
 * (the simple UI opens a space file link in its own pane). Modified clicks
 * and every other link open in a new tab as before.
 */
export const MarkdownLinkContext = createContext<((href: string) => boolean) | null>(null);

/**
 * Where a `termag-compose:` link's text goes (the file view's message box,
 * pages/chat/FileChat.tsx). Without one, such a link is its label as plain text.
 */
export const ComposeLinkContext = createContext<((text: string) => void) | null>(null);

/**
 * Draws a Markdown image instead of the reply's link (a space file's view,
 * pages/chat/SpaceMarkdownImage.tsx). Without one, an http(s) image is a link
 * and any other is its alt text: a reply's images are never fetched.
 */
export const MarkdownImageContext = createContext<((img: { src: string; href: string | null; alt: string }) => React.ReactNode) | null>(null);

/** A plain click on `href` opened in place, as the context says (MarkdownLinkContext); for links drawn outside Inlines. */
export function useOpenInPlace(): (href: string) => ((e: React.MouseEvent) => void) | undefined {
  const openInPlace = useContext(MarkdownLinkContext);
  return openInPlace
    ? (href: string) => (e: React.MouseEvent) => { if (plainClick(e) && openInPlace(href)) e.preventDefault(); }
    : () => undefined;
}

function plainClick(e: React.MouseEvent): boolean {
  return e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
}

function Inlines({ nodes }: { nodes: Inline[] }) {
  const onLink = useOpenInPlace();
  const fill = useContext(ComposeLinkContext);
  const image = useContext(MarkdownImageContext);
  return (
    <>
      {nodes.map((n, i) => {
        switch (n.t) {
          case 'text': return <React.Fragment key={i}>{n.v}</React.Fragment>;
          case 'code': return <code key={i} className="md-code">{n.v}</code>;
          // Fills the message box; never sends, never navigates.
          case 'compose': return fill
            ? <button key={i} type="button" className="md-compose" title={`Put “${n.text}” in the message box`} onClick={() => fill(n.text)}><Inlines nodes={n.c} /></button>
            : <React.Fragment key={i}><Inlines nodes={n.c} /></React.Fragment>;
          case 'b': return <strong key={i}><Inlines nodes={n.c} /></strong>;
          case 'i': return <em key={i}><Inlines nodes={n.c} /></em>;
          case 's': return <del key={i}><Inlines nodes={n.c} /></del>;
          case 'a': return <a key={i} href={n.href} target="_blank" rel="noopener noreferrer" onClick={onLink(n.href)}><Inlines nodes={n.c} /></a>;
          case 'img':
            if (image) return <React.Fragment key={i}>{image(n)}</React.Fragment>;
            return n.href
              ? <a key={i} className="md-img" href={n.href} target="_blank" rel="noopener noreferrer" title={n.href} onClick={onLink(n.href)}>{n.alt || 'image'}</a>
              : <React.Fragment key={i}>{n.alt}</React.Fragment>;
          case 'br': return <br key={i} />;
          case 'details': return (
            <details key={i} className="md-details" open={n.open || undefined}>
              <Summary nodes={n.summary} />
              <div className="md-details-body"><Inlines nodes={n.c} /></div>
            </details>
          );
        }
      })}
    </>
  );
}

// `open` is the source's initial state. React writes it only when it changes,
// so a reader's toggle survives re-renders (MarkdownDetails.test.tsx).
function Summary({ nodes }: { nodes: Inline[] | null }) {
  return <summary>{nodes && nodes.length ? <Inlines nodes={nodes} /> : 'Details'}</summary>;
}

function CodeBlock({ block }: { block: CodeFence }) {
  const drawn = useContext(CodeFenceContext)?.(block);
  if (drawn != null) return drawn;
  if (isMermaidFence(block.lang) && !block.open) return <MermaidBlock source={block.text} />;
  return <PlainCodeBlock block={block} />;
}

export function PlainCodeBlock({ block }: { block: CodeFence }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(block.text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  };
  return (
    <div className="md-pre">
      <div className="md-pre-head">
        <span>{block.lang ?? 'code'}</span>
        <button type="button" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
      </div>
      <pre><code>{block.text}</code></pre>
    </div>
  );
}

/** A markdown table; also how the pane chat shows a box-drawn table (Blocks.tsx). An empty `head` has no header row. */
export function Table({ block }: { block: Extract<MdBlock, { type: 'table' }> }) {
  const style = (c: number) => (block.align[c] ? { textAlign: block.align[c]! } : undefined);
  return (
    <div className="md-table">
      <table>
        {block.head.length > 0 && (
          <thead>
            <tr>{block.head.map((cell, c) => <th key={c} style={style(c)}><Inlines nodes={cell} /></th>)}</tr>
          </thead>
        )}
        {block.rows.length > 0 && (
          <tbody>
            {block.rows.map((row, r) => (
              <tr key={r}>{row.map((cell, c) => <td key={c} style={style(c)}><Inlines nodes={cell} /></td>)}</tr>
            ))}
          </tbody>
        )}
      </table>
    </div>
  );
}

function Item({ item }: { item: MdItem }) {
  if (item.task == null) return <li><Blocks blocks={item.blocks} /></li>;
  return (
    <li className="md-task">
      <input type="checkbox" checked={item.task} disabled readOnly aria-label={item.task ? 'done' : 'not done'} />
      <Blocks blocks={item.blocks} />
    </li>
  );
}

function Blocks({ blocks }: { blocks: MdBlock[] }) {
  return (
    <>
      {blocks.map((b, i) => {
        switch (b.type) {
          case 'p': return <p key={i}><Inlines nodes={b.inline} /></p>;
          case 'h': {
            const Tag = (`h${b.level + 2 > 6 ? 6 : b.level + 2}`) as 'h3' | 'h4' | 'h5' | 'h6';
            return <Tag key={i}><Inlines nodes={b.inline} /></Tag>;
          }
          case 'code': return <CodeBlock key={i} block={b} />;
          case 'ul': return <ul key={i} className={b.tight ? 'md-tight' : undefined}>{b.items.map((it, j) => <Item key={j} item={it} />)}</ul>;
          case 'ol': return <ol key={i} start={b.start !== 1 ? b.start : undefined} className={b.tight ? 'md-tight' : undefined}>{b.items.map((it, j) => <Item key={j} item={it} />)}</ol>;
          case 'quote': return <blockquote key={i}><Blocks blocks={b.blocks} /></blockquote>;
          case 'table': return <Table key={i} block={b} />;
          case 'hr': return <hr key={i} />;
          case 'details': return (
            <details key={i} className="md-details" open={b.open || undefined}>
              <Summary nodes={b.summary} />
              <div className="md-details-body"><Blocks blocks={b.blocks} /></div>
            </details>
          );
        }
      })}
    </>
  );
}

export function Markdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  return <div className="md"><Blocks blocks={parseMarkdown(text, { streaming })} /></div>;
}
