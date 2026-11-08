# Theme of the day

A dated reskin of both UIs (the full UI at `/termag/` and the simple UI at
`/termag/chat`), one per day, inspired by the season, Oakland's weather and
what happened on that date. People opt in from Settings → Appearance; the
whole thing is behind `daily-theme-enabled`.

It comes in two halves:

- **The engine** (`frontend/src/theme/daily/`, written by hand): it finds the
  days, loads today's, applies it, draws its sprite, and lints every day.
- **The days** (`frontend/src/theme/daily/<YYYY-MM-DD>/`), one directory each,
  written by the `theme-of-the-day` repo skill (`.claude/skills/theme-of-the-day/`)
  and opened as a PR by a separate automation.

## Who sees it

A day's theme applies when all of these hold:

- `daily-theme-enabled` is on for the person (client only; the server does not read it).
- They turned on **Theme of the day** in Settings → Appearance (`ThemeSettings.dailyTheme`,
  an optional key in both `theme/schema.ts` copies; absent means off).
- There is a directory for today's **Pacific** date (`date.ts` `pacificDate`). An open
  tab checks the date once a minute, so it turns over at midnight in Oakland.

`?dailyTheme=<YYYY-MM-DD>` on a workspace, Settings or simple-UI page shows that
day whatever the setting says, while the flag is on for that person;
`?dailyTheme=off` shows no day, even to someone who turned the theme on. Either is kept in `sessionStorage` for the tab,
until the tab closes or the other is asked for. It exists for the preview script
and for reviewers.

A day applies where the layer is mounted: the workspace, the simple UI and
Settings (so turning it on shows it there at once). The standalone pages outside them (`/dashboard`,
`/admin`, the phone client at `/m`) keep the usual look; the dashboard is outside
the flag provider on purpose, so it can't read the flag.

A day only reaches people once its PR is merged **and deployed** (merged is not
deployed). The skill writes tomorrow's day the evening
before, so a nightly deploy picks it up; a day that misses its deploy is never
seen, and nothing breaks.

Turn it off for everyone with the flag: nothing of a day is fetched or applied
while it is off, `?dailyTheme=` previews included, and an override is not even
remembered. It is a permanent kill switch (`lifecycle: 'kill-switch'`), not a
release flag to clean up, since every day is agent-written CSS and sprite code. The Thanksgiving turkeys win over a day's sprite in the full
UI (the day's CSS still applies).

## What a day may contain

| File | Required | What it is |
|------|----------|------------|
| `meta.json` | yes | A `DailyThemeMeta` as JSON, with no other keys: the date again, a title (≤ 60 characters), a blurb (≤ 280, plain text), 1 to 6 https sources (`label`, `url`). Settings → Appearance shows them. Read as data, never imported (`meta.ts` checks it). |
| `theme.css` | yes | Any CSS, with every selector under `html[data-daily-theme="<date>"]`. |
| `sprite.js` | no | Plain JavaScript (types in JSDoc, no imports) whose one `export default`, at the start of a line, is a `DailySprite` (`types.ts`). It runs in the sandboxed sprite frame, never as termag. |

`lint.ts` holds every day to these rules and `lint.test.ts` runs it over every
directory, so CI fails a day that breaks one:

- **CSS**: every selector starts with the day's scope (another day's, or none,
  fails); only `@media`, `@supports`, `@container` and `@keyframes`, whose names
  start with `dt-<yyyymmdd>-`; no `@import`, `@font-face`, `!important`,
  `expression()`, `image-set()` or `url()` other than a `data:image/` URI; any
  animation or transition sits inside `@media (prefers-reduced-motion: no-preference)`;
  nothing may select the engine's sprite frame (`.daily-theme-decor`) or style element;
  16 KB at most.
- **Sprite**: plain JavaScript (no TypeScript syntax: the frame runs it as it
  is); no imports; one export, the default, starting a line at the top level;
  none of `window`, `document`, `fetch`, timers, storage, `eval`, `Function`,
  `constructor` and the rest of `BANNED_IDENTIFIERS`; no string-keyed indexing;
  16 KB at most.

The lint is a tripwire, not the boundary: `'con' + 'structor'` gets past any
denylist. A sprite's boundary is its frame (below), which no source can lint
its way out of. **Every day's PR is still reviewed by a person**, with its
screenshots, before it merges, for the CSS above all. Don't turn on auto-merge
for these PRs.

## How a day is applied

`DailyThemeLayer` is mounted once per page, inside its flag provider:
the full UI's `MainLayout` and the Settings route in `App.tsx`, and the simple
UI's `ChatApp`. They are separate routes, so only one is mounted at a time. For
today's day it sets `html[data-daily-theme=<date>]` and appends one
`<style data-daily-theme-style>` with the day's CSS to `<head>`, after App.css
and chrome.css, and removes both on unmount or when the day ends.

A day's CSS usually sets termag's tokens (`--accent`, `--accent-dim`,
`--accent-rgb`, the `--bg-*` and `--text-*` set). Set them in three places,
because the simple UI's chrome refresh and LaunchPad overlays set their own:
`html[data-daily-theme=…]`, `… .chat-root[data-chrome='refresh']` and `… .lp-theme`,
and again under `[data-palette="light"]` for light. `2026-11-05/theme.css` is
the example.

### The sprite's frame

A sprite is code an agent wrote from research on the web, so it never runs as
termag. `DailyDecor.tsx` puts it in an `<iframe class="daily-theme-decor">` over
the whole page with `sandbox="allow-scripts"` and nothing else: an opaque origin
(no termag cookies, storage or DOM, no popups, forms or navigation). The frame's
document (`spriteFrame.ts` `spriteDocument`) has a CSP of
`default-src 'none'; script-src 'nonce-…'; style-src 'unsafe-inline'`: no fetch,
images or fonts, and no `eval` or `Function`. It runs three scripts with that
nonce: a guard that reports any error, the sprite (its `export default` becomes
`window.__dailySprite`), and the runner that sizes the canvas and draws frames.
The same shape as the Mermaid frame (`chat/mermaid.ts`). Never add
`allow-same-origin` to the sandbox or a `connect-src` to the CSP.

The page and the frame talk only through `postMessage`: the frame says `ready`
(with the opacity the sprite asks for) or `stopped`, and the page reads only its
own frame's window (`readSpriteMessage`). The page holds the iframe at
`pointer-events: none`, `aria-hidden`, out of the tab order, invisible until
`ready`, and at an opacity capped at `MAX_DECOR_OPACITY`; lint.ts keeps a day's
CSS off the element. The runner draws nothing while the page is hidden
(`document.hidden`, not just the browser's own throttling), caps the frame rate
at `MAX_DECOR_FPS`, draws
one still frame under reduced motion, and stops a sprite that throws or whose
frames take over 12 ms twenty times in a row; then the page removes the frame
and the rest of the day stays. A sprite could defeat the runner's caps, since
they share the frame, but only by burning CPU. Unlike the starfield it draws in
both palettes and with a solid background.

There is no frame on a touch screen (`(any-pointer: coarse)`, `TOUCH_ANY_QUERY`
in `DailyDecor.tsx`): the day's CSS applies, its sprite does not. It asks about
any pointer, not only the primary one the mobile redirect's `TOUCH_MEDIA_QUERY`
checks, so an iPad with a trackpad still gets no frame. On iOS Safari a fixed full-screen
iframe over the page stops one-finger scrolling of what is under it, though it
has `pointer-events: none` and taps still go through, so with the theme on the
simple UI's transcript would not scroll on an iPhone (2026-11-06). Don't bring
the frame back on touch without checking a scroll on a real iPhone.

A hostile sprite was checked against this in Chromium (#1338): `self.origin` is
`null`; `parent.document`, `document.cookie`, `localStorage` and `top.location`
throw `SecurityError`; `fetch` to termag and an `Image` load are refused by the
CSP; `Function` from an arrow's `constructor` throws `EvalError`.

Each day's files are lazy chunks found with `import.meta.glob`, all three read
as text and never imported as modules, because none of a day may run as termag:
`meta.json` is parsed and checked before it is used (a day whose meta fails is
skipped), the CSS applies under its scope, and the sprite runs only in its frame.
`lint.test.ts` fails if the registry ever imports a day file as a module. They
are found that way so adding a day touches only its own directory and
nothing loads for people who did not opt in. A loaded day is kept for the tab,
so a page switch has it at once, and the layer applies it before paint.

## Preview

With a local stack up with the flag on (`docs/e2e-stack.md`):

```bash
make e2e-up E2E_FLAGS='{"daily-theme-enabled":true}'
node scripts/daily-theme/preview.mjs 2026-11-05
```

It signs in, and for each UI and palette takes a screenshot with and without
the day (`?dailyTheme=<date>` and `?dailyTheme=off`), and runs axe-core's
`color-contrast` rule on both. It fails (exit 1) on a contrast violation the
day adds, or on one the app already has whose ratio the day lowers; the app's
own violations are not the day's to fix, but it may not make them worse. Output goes to `.termag/theme-of-the-day/out/<date>/screenshots/`
(gitignored): `<full|simple>-<dark|light>.png`, the `-before` pairs, and
`contrast.json`. It uses the Playwright in `/opt/playwright`;
`PLAYWRIGHT_MODULE` points it at another. It switches the signed-in user's palette through the API
and puts it back, so run one preview at a time per stack: two at once read each
other's palette.

## The skill

`.claude/skills/theme-of-the-day/SKILL.md` writes one day:

1. Researches the date with `scripts/theme-of-the-day/research.mjs <date>`:
   - computed locally: the season, sun and moon, and US holidays
   - fetched: the NWS forecast for Oakland and Wikipedia's "on this day"; each
     fetch can fail on its own, into `errors`
2. Picks one motif by the topic rules in the skill.
3. Writes only that day's directory, and prunes old days.
4. Runs the lint, typecheck and preview.
5. Commits without pushing.

It hands over in `.termag/theme-of-the-day/out/<date>/` (gitignored):
`research.json`, `pr-title.txt`, `pr-body.md` and `screenshots/`. It ends with
a line `THEME_OF_THE_DAY: <date> <ok|failed> <out dir>` on stdout.

Fetched text reaches the agent only as plain words under the brief's
`untrusted` key (`lib.mjs` `untrustedText`: no backticks, tags, braces, `$`,
control or invisible characters), and only from three allowed https hosts
(`isAllowedUrl`, checked on every redirect). The agent opens nothing else.

`scripts/theme-of-the-day/check-diff.mjs` is the path rule as code: everything
that differs from `origin/main` must be a day's `meta.json`, `theme.css` or
`sprite.js`. The skill runs it before it commits, and the automation that runs
the skill runs it again before it pushes and opens the PR from those files, and
requests a reviewer, never auto-merge. The skill's "The automation's half" is
the contract, and its "Running it safely" says not to run it with permission
prompts off: it reads web text and has a shell, so it runs with an allowlist of
its own commands.

`scripts/theme-of-the-day/lib.test.mjs` tests the research helpers against
saved responses in `fixtures/`, with sun, season and moon values checked
against the astral and ephem libraries
(`.github/workflows/theme-of-the-day.yml`).

## Keeping the directory small

The skill deletes days more than 14 days old in the same PR it adds one, so
the directory holds about two weeks. Git keeps the rest.
