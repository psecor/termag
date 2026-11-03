// What a run of tool calls is for, in Claude's own words: the sentence it
// writes just before the calls ("Let me find where the history is capped"),
// turned into a header ("Find where the history is capped"). Free, and the
// same live and in history, since the words are in the transcript.

/** About one line of the run's header. */
export const MAX_LEAD_IN = 80;

// A first word ending in -ing that is not a gerund.
const NOT_GERUND = new Set(['nothing', 'everything', 'something', 'anything', 'during', 'string', 'thing', 'king', 'ring', 'bring', 'sing', 'spring', 'swing', 'wing', 'morning', 'evening', 'pending', 'missing', 'existing', 'remaining', 'interesting', 'outstanding', 'following']);

// Words Claude puts ahead of what it is about to do: "Now", "Next,", "OK, so".
const CONNECTOR = /^(?:(?:ok(?:ay)?|now|next|then|first|so|and|alright|right|good|great|perfect|also|finally)\b[,.!:—–-]*\s+)+/i;
// "Let me", "I'll", "I'm going to", "We need to": the person, not the task.
const SUBJECTS = "let me|let's|let us|i'll|i will|i'm going to|i am going to|i'm gonna|i need to|i want to|i should|i can|we'll|we will|we need to|we should|i'm|i am";
const SUBJECT = new RegExp(`^(?:${SUBJECTS})\\s+`, 'i');
// The same words later in a sentence: "The Read fails, so I'll add a README".
const LATER_SUBJECT = new RegExp(`(?:^|[\\s,;(—–-])(?:${SUBJECTS.replace(/\|i'm\|i am$/, '')})\\s+(.+)$`, 'i');

/** Markdown down to the words: no code blocks, no emphasis or link syntax. */
function plain(text: string): string {
  return text
    .replace(/```[\s\S]*?(?:```|$)/g, '\n')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`\n]*)`/g, (_, code: string) => code.replace(/[*_~]/g, c => `\u0000${c}`))
    .replace(/(\*{1,3}|~~)([^*~\n]+)\1/g, '$2')
    .replace(/(^|\W)_{1,3}([^_\n]+)_{1,3}(?=\W|$)/g, '$1$2')
    .replace(/\u0000/g, '')
    .replace(/^\s*(?:[-*+>]|\d+[.)]|#{1,6})\s+/gm, '');
}

function sentences(text: string): string[] {
  return plain(text)
    .split(/\n+|(?<=[.!?:])\s+(?=[A-Z"'(])/)
    .map(s => s.trim())
    .filter(s => /[a-z]/i.test(s));
}

function isGerund(word: string): boolean {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  return w.length > 4 && w.endsWith('ing') && !NOT_GERUND.has(w);
}

/** Whether the sentence says what Claude is about to do, rather than what it found. */
function isIntent(sentence: string): boolean {
  const rest = sentence.replace(CONNECTOR, '');
  if (SUBJECT.test(rest) || LATER_SUBJECT.test(rest)) return true;
  if (rest !== sentence) return true; // "Now the tests:", "Next, a probe"
  // A sentence ending in a colon introduces the calls that follow it.
  return /:$/.test(rest) || isGerund(rest.split(/\s+/)[0] ?? '');
}

/** "Now let me check the CSS." → "Check the CSS"; "I'm checking it" → "Checking it". */
export function asHeader(sentence: string): string {
  let s = sentence.replace(CONNECTOR, '');
  // "For a cleaner demo I'll add a README" → "add a README".
  const later = SUBJECT.test(s) ? null : LATER_SUBJECT.exec(s);
  if (later) s = later[1];
  s = s.replace(SUBJECT, '').replace(CONNECTOR, '');
  s = s.replace(/^(?:also|just|quickly|first)\s+/i, '');
  s = s.replace(/[\s.:;,!…—–-]+$/, '').trim();
  if (s.length > MAX_LEAD_IN) {
    const cut = s.slice(0, MAX_LEAD_IN - 1);
    const space = cut.lastIndexOf(' ');
    s = `${(space > MAX_LEAD_IN / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:—–-]+$/, '')}…`;
  }
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * The header a lead-in gives its run, or null when it says nothing a header
 * could use ("Done.", a code block, a one-word reply). Of its sentences, the
 * last one that says what Claude is about to do, since that is the one the
 * calls carry out; a lead-in that only reports findings gives its first.
 */
export function leadInHeadline(text: string | null | undefined): string | null {
  if (!text) return null;
  const all = sentences(text);
  if (!all.length) return null;
  const intents = all.filter(isIntent);
  const header = asHeader(intents.length ? intents[intents.length - 1] : all[0]);
  return header.split(/\s+/).length >= 3 ? header : null;
}
