// A PR's description, or a review comment, as termag renders it: GitHub's
// markdown through the chat's own renderer (chat/Markdown.tsx, which never
// interprets HTML), less the HTML comments GitHub hides. A PR template leaves
// its instructions in `<!-- … -->`; termag would otherwise show them as text.
// Inside fenced code or an inline code span a comment is code, so it stays, as
// on GitHub; so does every line of a fence, blank ones included.

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
// A code span (a run of backticks, to the same run) is kept as it is; a comment outside one goes.
const SPAN_OR_COMMENT = /(`+)[\s\S]*?\1(?!`)|<!--[\s\S]*?-->/g;
const stripComments = (text: string) => text.replace(SPAN_OR_COMMENT, m => (m.startsWith('<!--') ? '' : m));

/** `body` without its closed HTML comments (outside fenced code and code spans), trimmed. */
export function prDescription(body: string | null | undefined): string {
  if (!body) return '';
  const lines = body.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let text: string[] = [];
  let fence: string | null = null;
  // A removed comment leaves its blank lines behind: outside a fence, a run of them is one.
  const flush = () => {
    if (text.length) out.push(stripComments(text.join('\n')).replace(/\n{3,}/g, '\n\n'));
    text = [];
  };
  for (const line of lines) {
    const m = FENCE.exec(line);
    if (fence) {
      out.push(line);
      // A closing fence is the same character, at least as long, and nothing after it.
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length && !line.slice(m[0].length).trim()) fence = null;
      continue;
    }
    if (m) { flush(); fence = m[1]; out.push(line); continue; }
    text.push(line);
  }
  flush();
  return out.join('\n').trim();
}
