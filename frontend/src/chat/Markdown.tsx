// A reply's markdown (chat/markdownParse.ts) as React elements. Text only: no
// HTML is ever interpreted, links are http(s) or mailto and open in a new
// tab, and an image is a link to it, never fetched.
import React, { createContext, useContext, useState } from 'react';
import { parseMarkdown, type Inline, type MdBlock, type MdItem } from './markdownParse';

/**
 * A plain click on a link asks this first; true means it was opened in place
 * (the simple UI opens a space file link in its own pane). Modified clicks
 * and every other link open in a new tab as before.
 */
export const MarkdownLinkContext = createContext<((href: string) => boolean) | null>(null);

function plainClick(e: React.MouseEvent): boolean {
  return e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
}

function Inlines({ nodes }: { nodes: Inline[] }) {
  const openInPlace = useContext(MarkdownLinkContext);
  const onLink = openInPlace
    ? (href: string) => (e: React.MouseEvent) => { if (plainClick(e) && openInPlace(href)) e.preventDefault(); }
    : () => undefined;
  return (
    <>
      {nodes.map((n, i) => {
        switch (n.t) {
          case 'text': return <React.Fragment key={i}>{n.v}</React.Fragment>;
          case 'code': return <code key={i} className="md-code">{n.v}</code>;
          case 'b': return <strong key={i}><Inlines nodes={n.c} /></strong>;
          case 'i': return <em key={i}><Inlines nodes={n.c} /></em>;
          case 's': return <del key={i}><Inlines nodes={n.c} /></del>;
          case 'a': return <a key={i} href={n.href} target="_blank" rel="noopener noreferrer" onClick={onLink(n.href)}><Inlines nodes={n.c} /></a>;
          case 'img': return <a key={i} className="md-img" href={n.href} target="_blank" rel="noopener noreferrer" title={n.href} onClick={onLink(n.href)}>{n.alt || 'image'}</a>;
          case 'br': return <br key={i} />;
        }
      })}
    </>
  );
}

function CodeBlock({ block }: { block: Extract<MdBlock, { type: 'code' }> }) {
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

function Table({ block }: { block: Extract<MdBlock, { type: 'table' }> }) {
  const style = (c: number) => (block.align[c] ? { textAlign: block.align[c]! } : undefined);
  return (
    <div className="md-table">
      <table>
        <thead>
          <tr>{block.head.map((cell, c) => <th key={c} style={style(c)}><Inlines nodes={cell} /></th>)}</tr>
        </thead>
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
        }
      })}
    </>
  );
}

export function Markdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  return <div className="md"><Blocks blocks={parseMarkdown(text, { streaming })} /></div>;
}
