// Transcript blocks (chat/paneChat.ts) as React, shared by the phone's
// Conversation and the desktop chat. Plain text throughout, so native
// selection, copy and find-in-page work.
import React, { useState } from 'react';
import { Block, splitFences } from './paneChat';
import './blocks.css';

function ToolBlock({ block, onShare }: { block: Block; onShare?: (block: Block) => void }) {
  const [open, setOpen] = useState(false);
  const lines = block.result ? block.result.split('\n').length : 0;
  return (
    <div className="m-block m-block-tool" data-partial={block.partial || undefined} data-failed={block.failed || undefined}>
      <button className="m-tool-head" onClick={() => setOpen(o => !o)} aria-expanded={open}>
        <span className="m-tool-marker">{block.failed ? '✗' : '⏺'}</span>
        <span className="m-tool-title">{block.text || 'tool'}</span>
        {lines > 0 && <span className="m-tool-count">{open ? '▾' : '▸'} {lines}</span>}
      </button>
      {open && block.result && (
        <>
          <pre className="m-tool-result">{block.result}</pre>
          {onShare && <button className="m-tool-share" onClick={() => onShare(block)}>Share</button>}
        </>
      )}
    </div>
  );
}

/** Block prose with any ``` fenced code shown as code. */
function RichText({ text }: { text: string }) {
  const parts = splitFences(text);
  if (parts.length <= 1 && !parts[0]?.code) return <div className="m-block-text">{text}</div>;
  return (
    <div className="m-block-text">
      {parts.map((p, i) => (p.code ? <pre key={i} className="m-code">{p.text}</pre> : <div key={i}>{p.text}</div>))}
    </div>
  );
}

export function BlockView({ block, agentLabel, banner, dialogHint, onShareTool }: {
  block: Block;
  agentLabel: string;
  banner?: boolean;
  /** Where the answer keys are, for a dialog block; defaults to the phone's key bar wording. */
  dialogHint?: string;
  /** A Share button under an opened tool result (the phone's share-out). */
  onShareTool?: (block: Block) => void;
}) {
  if (block.kind === 'tool') return <ToolBlock block={block} onShare={onShareTool} />;
  if (block.kind === 'plain') return <pre className="m-block m-block-plain">{block.text}</pre>;
  // `banner`: the shell's MOTD before the CLI started, the only text that is
  // meant to recede. Any other system block is something the grammar did not
  // recognise and must stay readable.
  if (block.kind === 'system') return <pre className="m-block m-block-system" data-banner={banner || undefined}>{block.text}</pre>;
  if (block.kind === 'dialog') {
    return (
      <div className="m-block m-block-dialog">
        <div className="m-block-who">{dialogHint ?? (block.options ? 'question · answer with the number keys below' : `${agentLabel} is asking · use ↑ ↓ and Enter below`)}</div>
        <pre className="m-dialog-text">{block.text}</pre>
      </div>
    );
  }
  return (
    <div className={`m-block m-block-${block.kind}`} data-partial={block.partial || undefined}>
      <div className="m-block-who">{block.kind === 'you' ? 'you' : block.kind === 'thinking' ? `${agentLabel} · thinking` : agentLabel}</div>
      <RichText text={block.text} />
    </div>
  );
}

/** Text typed into the pane's input box but not submitted. */
export function DraftView({ draft }: { draft: string }) {
  return (
    <div className="m-draft" title="Typed in the pane but not sent">
      <span className="m-draft-label">in the pane, unsent</span>
      <span className="m-draft-text">{draft}</span>
    </div>
  );
}

/**
 * Index of the first real turn: system blocks before it are the shell's
 * banner (rendered receding). -1 when there is no turn yet.
 */
export function firstTurnIndex(blocks: readonly Block[]): number {
  return blocks.findIndex(b => b.kind !== 'system');
}
