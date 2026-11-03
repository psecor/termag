import { describe, expect, it } from 'vitest';
import { asHeader, leadInHeadline, MAX_LEAD_IN } from './leadIn';

describe('leadInHeadline', () => {
  it('turns "Let me", "I\'ll", "Now" into an imperative', () => {
    expect(leadInHeadline('Let me find where the history is capped.')).toBe('Find where the history is capped');
    expect(leadInHeadline("I'll reattach a proper background waiter to the same message:")).toBe('Reattach a proper background waiter to the same message');
    expect(leadInHeadline('Now let me check the CSS and the tests.')).toBe('Check the CSS and the tests');
    expect(leadInHeadline("Okay, so I'm going to run the suite again.")).toBe('Run the suite again');
    expect(leadInHeadline('Next, I need to update the docs.')).toBe('Update the docs');
  });

  it('takes the sentence that says what comes next, not the finding before it', () => {
    expect(leadInHeadline('Postgres is installed. Now installing deps and starting the stack with the fake Claude:'))
      .toBe('Installing deps and starting the stack with the fake Claude');
    expect(leadInHeadline('The whole flow works end to end. The Read fails only because there is no README. For a cleaner demo I\'ll put a README into that checkout:'))
      .toBe('Put a README into that checkout');
    expect(leadInHeadline("Playwright can't see the simple UI until the flag is on. Checking how the flags reach the stack:"))
      .toBe('Checking how the flags reach the stack');
  });

  it('falls back to the first sentence when none says what comes next', () => {
    expect(leadInHeadline('The clone wants credentials. That is expected on the stub.')).toBe('The clone wants credentials');
  });

  it('reads markdown as words, and keeps code spans whole', () => {
    expect(leadInHeadline("Loading the list needs GitHub, so I'll restart with `E2E_FAKE_GITHUB=1` and use **its** seeded repo:"))
      .toBe('Restart with E2E_FAKE_GITHUB=1 and use its seeded repo');
    expect(leadInHeadline('Let me read [the guide](https://x.test/g) first.')).toBe('Read the guide first');
  });

  it('says nothing for a lead-in a header cannot use', () => {
    expect(leadInHeadline('Done.')).toBeNull();
    expect(leadInHeadline('Got it.')).toBeNull();
    expect(leadInHeadline('```bash\nnpm test\n```')).toBeNull();
    expect(leadInHeadline('')).toBeNull();
    expect(leadInHeadline(null)).toBeNull();
  });

  it('does not take "Nothing" or "Everything" for a gerund', () => {
    expect(leadInHeadline('Nothing else uses it. Everything checks out.')).toBe('Nothing else uses it');
  });

  it('cuts a long sentence at a word, to about one line', () => {
    const h = leadInHeadline(`Let me ${'check every single file in the repository '.repeat(4)}now.`)!;
    expect(h.length).toBeLessThanOrEqual(MAX_LEAD_IN);
    expect(h.endsWith('…')).toBe(true);
    expect(h).not.toMatch(/\s…$/);
  });
});

describe('asHeader', () => {
  it('capitalises and drops trailing punctuation', () => {
    expect(asHeader('let me look:')).toBe('Look');
    expect(asHeader('so, the overlap check.')).toBe('The overlap check');
  });
});
