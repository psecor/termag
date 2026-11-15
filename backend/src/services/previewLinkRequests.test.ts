// An agent's note is its own words: one line, bounded, never markup (services/previewLinkRequests.ts).
import { describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({ prisma: {} }));
vi.mock('./featureFlags', () => ({ boolVariation: vi.fn(async () => false), numberVariation: vi.fn(async () => 24) }));
const { cleanNote, slackQuote, slackText, NOTE_MAX } = await import('./previewLinkRequests');

describe('the agent note', () => {
  it('is one line of at most NOTE_MAX characters, with control characters and line separators gone', () => {
    expect(cleanNote(' the\\nVite\u0000app\r\n on 5173 ')).toBe('the\\nVite app on 5173');
    expect(cleanNote('a\nb\tc')).toBe('a b c');
    expect(cleanNote('x'.repeat(500))).toHaveLength(NOTE_MAX);
    expect(cleanNote('  \n ')).toBeNull();
    expect(cleanNote(undefined)).toBeNull();
  });

  it('sits in an inline code span in Slack, so a bare URL isn\'t a link and backticks can\'t break out (Bugbot, #1568)', () => {
    expect(slackQuote('see https://evil.example/login ```')).toBe("`see https://evil.example/login '''`");
    expect(slackQuote('<!here>')).toBe('`&lt;!here&gt;`');
  });

  it('can\'t mention anyone or make a link in Slack', () => {
    expect(slackText('<!channel> <@U123> <https://evil.example|click> & co')).toBe('&lt;!channel&gt; &lt;@U123&gt; &lt;https://evil.example|click&gt; &amp; co');
  });
});
