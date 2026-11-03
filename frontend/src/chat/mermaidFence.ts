// Which files and fences are Mermaid diagrams (chat/mermaid.ts draws them).
// Its own small module: Markdown, the pane chat and the file views ask this
// statically, and the drawing code loads only with a diagram.
/** File extensions shown as a diagram. */
export const MERMAID_EXTENSIONS: readonly string[] = ['mmd', 'mermaid'];

export function isMermaidPath(path: string): boolean {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 && MERMAID_EXTENSIONS.includes(base.slice(dot + 1).toLowerCase());
}

/** A fence's info string names Mermaid: its first word is `mermaid`, in any case. */
export function isMermaidFence(lang: string | null | undefined): boolean {
  return (lang ?? '').trim().split(/\s+/)[0].toLowerCase() === 'mermaid';
}
