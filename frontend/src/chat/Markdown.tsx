// A reply's markdown (chat/markdown.ts) as React elements. Text only: no
// HTML is ever interpreted, links are http(s) and open in a new tab.
import React, { useState } from 'react';
import { parseMarkdown, type Inline, type MdBlock } from './markdown';

function Inlines({ nodes }: { nodes: Inline[] }) {
  return (
    <>
      {nodes.map((n, i) => {
        switch (n.t) {
          case 'text': return <React.Fragment key={i}>{n.v}</React.Fragment>;
          case 'code': return <code key={i} className="md-code">{n.v}</code>;
          case 'b': return <strong key={i}><Inlines nodes={n.c} /></strong>;
          case 'i': return <em key={i}><Inlines nodes={n.c} /></em>;
          case 'a': return <a key={i} href={n.href} target="_blank" rel="noopener noreferrer"><Inlines nodes={n.c} /></a>;
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

export function Markdown({ text }: { text: string }) {
  const blocks = parseMarkdown(text);
  return (
    <div className="md">
      {blocks.map((b, i) => {
        switch (b.type) {
          case 'p': return <p key={i}><Inlines nodes={b.inline} /></p>;
          case 'h': {
            const Tag = (`h${b.level + 2 > 6 ? 6 : b.level + 2}`) as 'h3' | 'h4' | 'h5' | 'h6';
            return <Tag key={i}><Inlines nodes={b.inline} /></Tag>;
          }
          case 'code': return <CodeBlock key={i} block={b} />;
          case 'ul': return <ul key={i}>{b.items.map((it, j) => <li key={j}><Inlines nodes={it} /></li>)}</ul>;
          case 'ol': return <ol key={i}>{b.items.map((it, j) => <li key={j}><Inlines nodes={it} /></li>)}</ol>;
          case 'quote': return <blockquote key={i}><Inlines nodes={b.inline} /></blockquote>;
          case 'hr': return <hr key={i} />;
        }
      })}
    </div>
  );
}
