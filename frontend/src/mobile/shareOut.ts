// Share out: a transcript block or tool result to
// another app through the system share sheet, else the clipboard.

/** Returns what happened, so the caller can say "Copied". */
export async function shareText(text: string, title?: string): Promise<'shared' | 'copied' | 'cancelled' | 'failed'> {
  const nav = typeof navigator !== 'undefined' ? navigator : null;
  if (nav?.share) {
    try { await nav.share({ text, ...(title ? { title } : {}) }); return 'shared'; }
    catch (err) { if ((err as Error)?.name === 'AbortError') return 'cancelled'; }
  }
  try { await nav?.clipboard?.writeText(text); return 'copied'; } catch { return 'failed'; }
}
