// The composer bars at a phone's width (320 to 430px): a pill's words never wrap (wrapped, the
// model's and Permissions' words ran into each other at 320px), and where one row can't hold
// them New session's Permissions and orchestrator take a row of their own above the model and
// the actions. jsdom does no layout or container queries, so this pins the rules.
import { describe, expect, it } from 'vitest';

async function read(name: string): Promise<string> {
  const fs = await import('node:fs' as string) as { readFileSync(path: URL, encoding: 'utf8'): string };
  return fs.readFileSync(new URL(`./${name}`, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Fails unless a rule whose selector is exactly `selector`, at or after `from`, sets `decl`. */
function sets(css: string, selector: string, decl: RegExp, from = 0): void {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*');
  const bodies = [...css.slice(from).matchAll(new RegExp(`(?:^|[}\\s])${esc}\\s*\\{([^}]*)\\}`, 'g'))].map(m => m[1]);
  expect(bodies.some(b => decl.test(b)), `${selector} { ${decl.source} }`).toBe(true);
}

/** Where the container query starts; what follows it is read as its rules. */
function query(css: string, name: string, max: number): number {
  const at = css.indexOf(`@container ${name} (max-width: ${max}px)`);
  expect(at, `${name} at ${max}px`).toBeGreaterThan(-1);
  return at;
}

describe("the composer bars' pills", () => {
  it('keep their words on one line and shorten them with an ellipsis', async () => {
    const css = await read('chat.css');
    sets(css, '.chat-compose-model-btn', /white-space:\s*nowrap/);
    for (const decl of [/overflow:\s*hidden/, /text-overflow:\s*ellipsis/, /min-width:\s*0/]) sets(css, '.chat-compose-pill-label', decl);
  });
});

describe("New session's bar", () => {
  it('is a container whose pills shrink before the actions wrap', async () => {
    const css = await read('chat.css');
    sets(css, '.chat-compose-bar', /container:\s*compose-bar\s*\/\s*inline-size/);
    sets(css, '.chat-compose-bar', /flex-wrap:\s*wrap/);
    sets(css, '.chat-compose-bar > .chat-compose-pills', /flex:\s*1 1 0/);
    sets(css, '.chat-compose-extras:empty', /display:\s*none/);
  });

  it('puts Permissions and the orchestrator on a row of their own where one row cannot hold them', async () => {
    const css = await read('chat.css');
    const at = query(css, 'compose-bar', 520);
    sets(css, '.chat-compose-bar > .chat-compose-pills', /display:\s*contents/, at);
    sets(css, '.chat-compose-pills > .chat-compose-extras', /order:\s*-1/, at);
    sets(css, '.chat-compose-pills > .chat-compose-extras', /flex:\s*1 0 100%/, at);
    sets(css, '.chat-compose-pills > .chat-compose-model', /flex:\s*1 1 0/, at);
  });
});

describe("a session's composer bar", () => {
  it('gives the model-change note a row of its own on a phone, and never wraps the actions', async () => {
    const css = await read('chat.css');
    sets(css, '.chat-composer', /container:\s*composer\s*\/\s*inline-size/);
    const at = query(css, 'composer', 479);
    sets(css, '.chat-composer-bar', /flex-wrap:\s*wrap/, at);
    sets(css, '.chat-composer-bar > .chat-composer-note', /order:\s*-1/, at);
    sets(css, '.chat-composer-bar > .chat-composer-note', /flex:\s*1 0 100%/, at);
    sets(css, '.chat-composer-bar > .chat-compose-model', /flex:\s*1 1 0/, at);
  });

  it('closes the gaps between its round buttons at 320 and 360px, and leaves the effort to the menu at 320', async () => {
    const css = await read('chat.css');
    sets(css, '.chat-composer-bar :is(.chat-compose-actions, .chat-compose-end)', /gap:\s*0/, query(css, 'composer', 359));
    sets(css, '.chat-composer-bar .chat-model-effort', /display:\s*none/, query(css, 'composer', 319));
  });
});
