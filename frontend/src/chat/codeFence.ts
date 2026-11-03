// A fenced block that something other than Markdown draws: the SDK chat's
// generative UI draws a ```spec fence (chat/genui/SpecFence.tsx). Its own
// module, so a test that stands in for Markdown still has the context.
import { createContext, type ReactNode } from 'react';
import type { MdBlock } from './markdownParse';

/** A fenced code block as the parser reads it (`open` until its closing fence has streamed in). */
export type CodeFence = Extract<MdBlock, { type: 'code' }>;

/** Draws a fence some other way: its element, or null for Markdown's usual code block. */
export const CodeFenceContext = createContext<((block: CodeFence) => ReactNode | null) | null>(null);
