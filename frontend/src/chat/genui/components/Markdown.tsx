// Formatted text: the chat's own markdown (chat/markdownParse.ts), drawn
// here rather than by chat/Markdown.tsx for two reasons. A link is drawn as
// its text, never as a link: a spec's text can be built from state
// ($template), and a link built from what the person typed could carry it to
// another site (the rule Link's fixed href keeps).
// And a fence is a plain code block, never another generated surface or a
// diagram. Not a control, so not LaunchPad's; the look is the chat's (.md).
import React, { useState } from 'react';
import { Button } from '@launchpad-ui/components';
import { z } from 'zod';
import { parseMarkdown, type Inline, type MdBlock, type MdItem } from '../../markdownParse';
import { defineGenUiComponent } from './index';
import './Markdown.css';

function Inlines({ nodes }: { nodes: Inline[] }) {
  return (
    <>
      {nodes.map((n, i) => {
        switch (n.t) {
          case 'text': return <React.Fragment key={i}>{n.v}</React.Fragment>;
          case 'code': return <code key={i} className="md-code">{n.v}</code>;
          case 'b': return <strong key={i}><Inlines nodes={n.c} /></strong>;
          case 'i': return <em key={i}><Inlines nodes={n.c} /></em>;
          case 's': return <del key={i}><Inlines nodes={n.c} /></del>;
          // A link's text, and a compose link's; an image's alt text. Never an href.
          case 'a': case 'compose': return <React.Fragment key={i}><Inlines nodes={n.c} /></React.Fragment>;
          case 'img': return <React.Fragment key={i}>{n.alt}</React.Fragment>;
          case 'br': return <br key={i} />;
          case 'details': return (
            <details key={i} className="md-details" open={n.open || undefined}>
              <summary>{n.summary?.length ? <Inlines nodes={n.summary} /> : 'Details'}</summary>
              <div className="md-details-body"><Inlines nodes={n.c} /></div>
            </details>
          );
        }
      })}
    </>
  );
}

/** A fence, as CodeBlock draws one (registry.tsx): the chat's code block, LaunchPad's Copy. */
function Code({ lang, text }: { lang: string | null; text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => {});
  };
  return (
    <div className="md-pre genui-code">
      <div className="md-pre-head">
        <span>{lang ?? 'code'}</span>
        <Button variant="minimal" size="small" onPress={copy}>{copied ? 'Copied' : 'Copy'}</Button>
      </div>
      <pre><code>{text}</code></pre>
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
            // Under the surface's own headings (Heading draws h3 to h6).
            const Tag = (`h${Math.min(6, b.level + 3)}`) as 'h4' | 'h5' | 'h6';
            return <Tag key={i}><Inlines nodes={b.inline} /></Tag>;
          }
          case 'code': return <Code key={i} lang={b.lang} text={b.text} />;
          case 'ul': return <ul key={i} className={b.tight ? 'md-tight' : undefined}>{b.items.map((it, j) => <Item key={j} item={it} />)}</ul>;
          case 'ol': return <ol key={i} start={b.start !== 1 ? b.start : undefined} className={b.tight ? 'md-tight' : undefined}>{b.items.map((it, j) => <Item key={j} item={it} />)}</ol>;
          case 'quote': return <blockquote key={i}><Blocks blocks={b.blocks} /></blockquote>;
          case 'table': {
            const style = (c: number) => (b.align[c] ? { textAlign: b.align[c]! } : undefined);
            return (
              <div key={i} className="md-table">
                <table>
                  <thead><tr>{b.head.map((cell, c) => <th key={c} style={style(c)}><Inlines nodes={cell} /></th>)}</tr></thead>
                  {b.rows.length > 0 && <tbody>{b.rows.map((row, r) => <tr key={r}>{row.map((cell, c) => <td key={c} style={style(c)}><Inlines nodes={cell} /></td>)}</tr>)}</tbody>}
                </table>
              </div>
            );
          }
          case 'hr': return <hr key={i} />;
          case 'details': return (
            <details key={i} className="md-details" open={b.open || undefined}>
              <summary>{b.summary?.length ? <Inlines nodes={b.summary} /> : 'Details'}</summary>
              <div className="md-details-body"><Blocks blocks={b.blocks} /></div>
            </details>
          );
        }
      })}
    </>
  );
}

export default defineGenUiComponent({
  name: 'Markdown',
  props: z.object({ text: z.string().max(6000) }),
  description: 'Formatted text in markdown: paragraphs, **bold**, *italic*, `code`, lists and task lists, headings, quotes, tables and code blocks. For a passage with formatting; use Text for a plain line. A link is shown as its text only: use Link for a link.',
  Component: ({ props }) => <div className="md genui-markdown"><Blocks blocks={parseMarkdown(props.text)} /></div>,
});
