import { describe, expect, it } from 'vitest';
import {
  BODY_MAX, ENTRY_FILES, compareEntries, copyProblems, entryId, isIsoDay, parseEntries, parseEntry, validEntries,
  type WhatsNewEntry,
} from './whatsNew';

const file = (fields: string, body = 'Open a terminal, files or the pull request beside the chat.') => `---\n${fields}\n---\n${body}\n`;
const FIELDS = 'title: Side panel tabs\nsurface: termag\ncategory: new\ndate: 2026-10-27';

function problemsOf(id: string, raw: string): string[] {
  const p = parseEntry(id, raw);
  return p.ok ? [] : p.problems;
}

const entry = (over: Partial<WhatsNewEntry>): WhatsNewEntry => ({
  id: 'x', title: 'X', surface: 'termag', category: 'new', date: '2026-10-27', flags: [], body: 'Body.', ...over,
});

describe('every entry in ./entries', () => {
  // The rule in docs/whats-new.md, held for each file the dialog bundles.
  for (const [path, raw] of Object.entries(ENTRY_FILES)) {
    it(`${entryId(path)} parses and follows the copy rules`, () => {
      const p = parseEntry(entryId(path), raw);
      expect(p.ok ? [] : p.problems, path).toEqual([]);
      if (p.ok) expect(copyProblems(p.entry), path).toEqual([]);
    });
  }

  it('has unique titles within each surface', () => {
    const seen = new Set<string>();
    for (const e of validEntries(parseEntries(ENTRY_FILES))) {
      const key = `${e.surface}: ${e.title.toLowerCase()}`;
      expect(seen.has(key), `two ${e.surface} entries are titled "${e.title}"`).toBe(false);
      seen.add(key);
    }
  });
});

describe('parseEntry', () => {
  it('reads the fields and the body', () => {
    expect(parseEntry('side-panel-tabs', file(`${FIELDS}\nflag: simple-ui-chrome-refresh-enabled`))).toEqual({
      ok: true,
      entry: {
        id: 'side-panel-tabs',
        title: 'Side panel tabs',
        surface: 'termag',
        category: 'new',
        date: '2026-10-27',
        flags: ['simple-ui-chrome-refresh-enabled'],
        body: 'Open a terminal, files or the pull request beside the chat.',
      },
    });
  });

  it('has no flags when the entry names none', () => {
    const p = parseEntry('side-panel-tabs', file(FIELDS));
    expect(p.ok && p.entry.flags).toEqual([]);
  });

  it('reads several flags, separated by commas', () => {
    const p = parseEntry('a', file(`${FIELDS}\nflag: simple-ui-side-panel-enabled,  spaces-enabled`));
    expect(p.ok && p.entry.flags).toEqual(['simple-ui-side-panel-enabled', 'spaces-enabled']);
    expect(problemsOf('a', file(`${FIELDS}\nflag: spaces-enabled, spaces-enabled`))).toEqual(['flag lists a key twice']);
  });

  it('keeps a colon in a value, takes CRLF files and strips matching quotes', () => {
    const p = parseEntry('a', file('title: "Box sizes: small, medium, large"\nsurface: lab\ncategory: changed\ndate: 2026-10-27').replace(/\n/g, '\r\n'));
    expect(p.ok && p.entry.title).toBe('Box sizes: small, medium, large');
    expect(p.ok && p.entry.surface).toBe('lab');
  });

  it('refuses a file without the --- block', () => {
    expect(problemsOf('a', 'title: X\n\nBody.')).toEqual(['it must start with a --- block of fields, closed by ---']);
  });

  it('names each missing field', () => {
    expect(problemsOf('a', file('title: X'))).toEqual(['surface is missing', 'category is missing', 'date is missing']);
  });

  it('refuses unknown and repeated fields', () => {
    expect(problemsOf('a', file(`${FIELDS}\nauthor: someone`))).toEqual([
      'unknown line "author: someone" (fields: title, surface, category, date, flag)',
    ]);
    expect(problemsOf('a', file(`${FIELDS}\ntitle: Again`))).toEqual(['title is given twice']);
  });

  it('checks surface, category and date', () => {
    expect(problemsOf('a', file('title: X\nsurface: both\ncategory: added\ndate: 2026-02-30'))).toEqual([
      'surface must be one of termag, lab, not "both"',
      'category must be one of new, changed, fixed, removed, not "added"',
      'date must be a real day written YYYY-MM-DD, not "2026-02-30"',
    ]);
  });

  it('takes only on/off flags the browser reads, each of them', () => {
    expect(problemsOf('a', file(`${FIELDS}\nflag: no-such-flag-enabled`))).toEqual([
      'flag must list on/off flags in frontend/src/flags.ts (FLAGS), not "no-such-flag-enabled"',
    ]);
    expect(problemsOf('a', file(`${FIELDS}\nflag: browser-pane-preview-share-ttl-hours`))).toHaveLength(1);
    expect(problemsOf('a', file(`${FIELDS}\nflag: spaces-enabled, no-such-flag-enabled`))).toHaveLength(1);
  });

  it('refuses an empty body and a file name that is not a slug', () => {
    expect(problemsOf('a', file(FIELDS, ''))).toEqual(['the body after the --- block is empty']);
    expect(problemsOf('Side_Panel', file(FIELDS))).toEqual([
      'the file name must be lowercase words joined by hyphens, not "Side_Panel"',
    ]);
  });
});

describe('copyProblems', () => {
  it('passes plain copy', () => {
    expect(copyProblems(entry({ title: 'Side panel tabs', body: 'Open a terminal beside the chat: add tabs with +.' }))).toEqual([]);
  });

  it('holds the title and body to their lengths, and the title to no full stop', () => {
    expect(copyProblems(entry({ title: 'x'.repeat(61) }))).toEqual(['the title is 61 characters; keep it to 60']);
    expect(copyProblems(entry({ title: 'Side panel tabs.' }))).toEqual(['the title ends with a full stop']);
    expect(copyProblems(entry({ body: 'x'.repeat(BODY_MAX + 1) }))).toEqual([
      `the body is ${BODY_MAX + 1} characters; keep it to ${BODY_MAX} (one or two sentences)`,
    ]);
  });

  it('keeps PR numbers, flag keys and the old UI names out of the copy', () => {
    expect(copyProblems(entry({ body: 'Shipped in #823.' }))).toEqual(['it cites a PR or issue number; say what changed instead']);
    expect(copyProblems(entry({ body: 'Behind box-sizes-enabled.' }))).toEqual(['it names a flag key; the flag goes in the flag field']);
    expect(copyProblems(entry({ body: 'Behind spaces-enabled.' }))).toHaveLength(1);
    expect(copyProblems(entry({ title: 'Tabs in the Simple UI' }))).toEqual(['it says simple or full UI; the two UIs are termag and lab']);
    expect(copyProblems(entry({ body: 'Back to the full-view list.' }))).toHaveLength(1);
  });

  it('lets a # that is not a number, and words like re-enabled, through', () => {
    expect(copyProblems(entry({ body: 'Post to #general from a chat.' }))).toEqual([]);
    expect(copyProblems(entry({ body: 'Notifications are re-enabled when you come back.' }))).toEqual([]);
  });
});

describe('ordering and loading', () => {
  it('sorts newest first, then New, Changed, Fixed, Removed within a day, then by id', () => {
    const list = [
      entry({ id: 'old', date: '2026-10-20' }),
      entry({ id: 'b-fix', category: 'fixed' }),
      entry({ id: 'gone', category: 'removed' }),
      entry({ id: 'b-new' }),
      entry({ id: 'a-new' }),
      entry({ id: 'change', category: 'changed' }),
    ];
    expect(list.sort(compareEntries).map(e => e.id)).toEqual(['a-new', 'b-new', 'change', 'b-fix', 'gone', 'old']);
  });

  it('names an entry by its file and drops the ones that do not parse', () => {
    const parsed = parseEntries({
      './entries/side-panel-tabs.md': file(FIELDS),
      './entries/broken.md': 'no fields',
    });
    expect(parsed.map(p => p.ok)).toEqual([false, true]);
    expect(validEntries(parsed).map(e => e.id)).toEqual(['side-panel-tabs']);
  });

  it('knows a real day', () => {
    expect(isIsoDay('2026-10-28')).toBe(true);
    expect(isIsoDay('2026-13-01')).toBe(false);
    expect(isIsoDay('2026-10-28T00:00')).toBe(false);
  });
});
