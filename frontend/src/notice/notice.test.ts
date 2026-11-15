// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  alertStatus, NOTICE_DISMISSED_KEY, noticeEnded, noticeParts, parseNotice, readDismissed, writeDismissed,
} from './notice';

const PSA = {
  id: 'chromium-psa-2026-11-13',
  tone: 'warning',
  title: 'Browsers are broken on boxes built since Nov 11.',
  message: "Open your box's **Terminal** tab and run `sudo snap install chromium`.",
  link: { label: 'Details', url: 'https://example.com/notices/chromium' },
  dismissible: true,
  endsAt: '2026-11-20T23:00:00Z',
};

describe('parseNotice', () => {
  it('reads a full notice', () => {
    expect(parseNotice(PSA)).toEqual({
      id: 'chromium-psa-2026-11-13',
      tone: 'warning',
      title: 'Browsers are broken on boxes built since Nov 11.',
      message: "Open your box's **Terminal** tab and run `sudo snap install chromium`.",
      link: { label: 'Details', url: 'https://example.com/notices/chromium' },
      dismissible: true,
      endsAt: Date.parse('2026-11-20T23:00:00Z'),
    });
  });

  it('is no notice for {}, null, a non-object, or a value without an id or a message', () => {
    for (const v of [{}, null, undefined, 'notice', 3, true, [PSA], { id: 'x' }, { message: 'hi' }, { id: 'x', message: '   ' }]) {
      expect(parseNotice(v), JSON.stringify(v)).toBeNull();
    }
  });

  it('takes only a lowercase id of letters, digits and dashes, at most 64 long', () => {
    for (const id of ['Chromium', 'has space', 'under_score', '-leading', 'a'.repeat(65), 'ok/slash']) {
      expect(parseNotice({ id, message: 'hi' }), id).toBeNull();
    }
    expect(parseNotice({ id: 'a'.repeat(64), message: 'hi' })?.id).toBe('a'.repeat(64));
    expect(parseNotice({ id: 'outage-2026-11-13-r2', message: 'hi' })?.id).toBe('outage-2026-11-13-r2');
  });

  it('falls back to info for a missing or unknown tone, and can be closed unless dismissible is false', () => {
    expect(parseNotice({ id: 'a', message: 'hi' })).toMatchObject({ tone: 'info', dismissible: true });
    expect(parseNotice({ id: 'a', message: 'hi', tone: 'danger', dismissible: 'no' })).toMatchObject({ tone: 'info', dismissible: true });
    expect(parseNotice({ id: 'a', message: 'hi', tone: 'outage', dismissible: false })).toMatchObject({ tone: 'outage', dismissible: false });
  });

  it('clips long text with an ellipsis and folds whitespace', () => {
    const n = parseNotice({ id: 'a', title: 't'.repeat(100), message: `${'m'.repeat(500)}`, link: { label: 'l'.repeat(30), url: 'https://example.com' } })!;
    expect(n.title).toHaveLength(80);
    expect(n.title!.endsWith('…')).toBe(true);
    expect(n.message).toHaveLength(400);
    expect(n.link!.label).toHaveLength(24);
    expect(parseNotice({ id: 'a', message: '  two\n\nlines  ' })!.message).toBe('two lines');
  });

  it('keeps an https link only', () => {
    const at = (url: unknown) => parseNotice({ id: 'a', message: 'hi', link: { label: 'Details', url } })?.link;
    expect(at('https://example.com/x')).toEqual({ label: 'Details', url: 'https://example.com/x' });
    for (const url of ['http://example.com', 'javascript:alert(1)', 'data:text/html,hi', '/relative', 'not a url', 42]) {
      expect(at(url), String(url)).toBeUndefined();
    }
    expect(parseNotice({ id: 'a', message: 'hi', link: { url: 'https://example.com' } })?.link).toBeUndefined();
  });

  it('ignores an end time that does not parse', () => {
    expect(parseNotice({ id: 'a', message: 'hi', endsAt: 'Friday' })!.endsAt).toBeUndefined();
    expect(parseNotice({ id: 'a', message: 'hi', endsAt: 1 })!.endsAt).toBeUndefined();
  });
});

describe('noticeEnded and alertStatus', () => {
  it('ends at endsAt, and never without one', () => {
    const n = parseNotice(PSA)!;
    expect(noticeEnded(n, Date.parse('2026-11-20T22:59:59Z'))).toBe(false);
    expect(noticeEnded(n, Date.parse('2026-11-20T23:00:00Z'))).toBe(true);
    expect(noticeEnded(parseNotice({ id: 'a', message: 'hi' })!, Date.parse('2099-01-01'))).toBe(false);
  });

  it('draws an outage as an error', () => {
    expect(alertStatus('info')).toBe('info');
    expect(alertStatus('warning')).toBe('warning');
    expect(alertStatus('outage')).toBe('error');
  });
});

describe('noticeParts', () => {
  it('splits text, bold and code', () => {
    expect(noticeParts("Open **Terminal** and run `sudo snap install chromium`, then `x`.")).toEqual([
      { kind: 'text', text: 'Open ' },
      { kind: 'bold', text: 'Terminal' },
      { kind: 'text', text: ' and run ' },
      { kind: 'code', text: 'sudo snap install chromium' },
      { kind: 'text', text: ', then ' },
      { kind: 'code', text: 'x' },
      { kind: 'text', text: '.' },
    ]);
  });

  it('shows anything else as typed, an unmatched marker included', () => {
    expect(noticeParts('<b>hi</b> [link](https://x) *one* `open')).toEqual([{ kind: 'text', text: '<b>hi</b> [link](https://x) *one* `open' }]);
    expect(noticeParts('a ** b')).toEqual([{ kind: 'text', text: 'a ** b' }]);
  });

  it('keeps an empty pair as typed and goes on to the markup after it', () => {
    expect(noticeParts('Use `` here, then run `echo hi`')).toEqual([
      { kind: 'text', text: 'Use `` here, then run ' },
      { kind: 'code', text: 'echo hi' },
    ]);
    expect(noticeParts('a **** b **bold**')).toEqual([
      { kind: 'text', text: 'a **** b ' },
      { kind: 'bold', text: 'bold' },
    ]);
  });

  it('keeps bold markers inside code as code', () => {
    expect(noticeParts('run `a **b** c`')).toEqual([{ kind: 'text', text: 'run ' }, { kind: 'code', text: 'a **b** c' }]);
  });
});

describe('dismissed ids', () => {
  beforeEach(() => localStorage.clear());

  it('remembers ids, newest last, and keeps the last 20', () => {
    expect(readDismissed()).toEqual([]);
    for (let i = 0; i < 25; i++) writeDismissed(`n-${i}`);
    const ids = readDismissed();
    expect(ids).toHaveLength(20);
    expect(ids[0]).toBe('n-5');
    expect(ids[19]).toBe('n-24');
    writeDismissed('n-5');
    expect(readDismissed().at(-1)).toBe('n-5');
    expect(readDismissed()).toHaveLength(20);
  });

  it('reads a damaged entry as none', () => {
    localStorage.setItem(NOTICE_DISMISSED_KEY, '{not json');
    expect(readDismissed()).toEqual([]);
    localStorage.setItem(NOTICE_DISMISSED_KEY, JSON.stringify({ id: 'a' }));
    expect(readDismissed()).toEqual([]);
    localStorage.setItem(NOTICE_DISMISSED_KEY, JSON.stringify(['a', 3, null]));
    expect(readDismissed()).toEqual(['a']);
  });
});
