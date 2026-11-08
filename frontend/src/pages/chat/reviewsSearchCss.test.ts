// The Reviews page's search (ReviewFilters.tsx) is a LaunchPad SearchField whose Group termag draws
// itself. Since the build keeps Group's own rules (launchpad/launchpadCss.ts), the Group is
// overflow: hidden, which lets a flex item shrink below its height, and it zeroes its input's
// padding. jsdom does no layout, so this pins the rules in reviews.css that hold the field's 32 px
// and its padding; checked in Chromium on #1298.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(__dirname, 'reviews.css'), 'utf8');
/** The declarations of the first rule whose selector list is exactly `selector`, anchored to a line start. */
function rule(selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`(^|\\n|\\})${esc}\\s*\\{([^}]*)\\}`).exec(css);
  return m ? m[2] : '';
}

describe('the Reviews search field', () => {
  it('keeps its 32 px under LaunchPad Group’s overflow: hidden', () => {
    const group = rule(".chat-root[data-chrome='refresh'] .rv-filter-search-group");
    expect(group).toMatch(/height:\s*32px/);
    expect(group).toMatch(/flex-shrink:\s*0/);
  });

  it('pads its input itself, since the Group zeroes it', () => {
    expect(rule(".chat-root[data-chrome='refresh'] .rv-filter-search-group input")).toMatch(/padding:\s*5px 8px/);
  });
});
