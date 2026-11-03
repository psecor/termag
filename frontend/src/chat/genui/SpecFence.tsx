// Generative UI's way into the chat:
// the SDK chat hands Markdown `renderGenUiFence` (Markdown's CodeFenceContext)
// while chat-generative-ui-enabled is on for the viewer, and a ```spec fence
// in a reply becomes UI. The renderer itself is a lazy chunk (GenUiSurface);
// until it loads, and while the fence has nothing to draw yet, the fence is
// a skeleton. If the chunk fails to load the fence is a plain code block.
import React, { createContext, lazy, Suspense, useContext } from 'react';
import type { CodeFence } from '../codeFence';
import { PlainCodeBlock } from '../Markdown';
import type { ActionPayload } from './action';
import { SpecSkeleton } from './SpecSkeleton';
import './genui.css';

const GenUiSurface = lazy(() => import('./GenUiSurface'));

/** The reply a fence is in (the SDK chat's text item): its key, and whether it is still streaming. */
export const GenUiItemContext = createContext<{ key: string; streaming: boolean }>({ key: '', streaming: false });

/**
 * The chat a surface answers into (SdkChatView): `send` posts a user message
 * the way the composer does (a new turn, or into a live one) and says whether
 * it went; `sent` is every surface already answered (action.ts sentSurfaces);
 * `ready`, whether it can take an answer now.
 * Without one, a surface's actions do nothing.
 */
export interface GenUiChat {
  send: (text: string) => Promise<boolean>;
  sent: ReadonlyMap<string, ActionPayload>;
  /**
   * Claude's runner is up. Until it is, an answer is refused, not queued: the
   * composer's pre-ready queue lives in this browser only, so the answer would
   * not be in the transcript to lock the surface everywhere else.
   */
  ready: boolean;
}
export const GenUiChatContext = createContext<GenUiChat | null>(null);

class ChunkBoundary extends React.Component<{ fallback: React.ReactNode; children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

function SpecFence({ block }: { block: CodeFence }) {
  const item = useContext(GenUiItemContext);
  const chat = useContext(GenUiChatContext);
  const fallback = <PlainCodeBlock block={block} />;
  return (
    <ChunkBoundary fallback={fallback}>
      <Suspense fallback={<SpecSkeleton />}>
        <GenUiSurface block={block} itemKey={item.key} streaming={item.streaming} chat={chat} fallback={fallback} />
      </Suspense>
    </ChunkBoundary>
  );
}

/** For Markdown's CodeFenceContext: a ```spec fence as generative UI; any other fence stays code. */
export function renderGenUiFence(block: CodeFence): React.ReactNode | null {
  return block.lang === 'spec' ? <SpecFence block={block} /> : null;
}
