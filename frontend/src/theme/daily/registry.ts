import { DAILY_THEME_DATE } from './date';
import { parseDailyThemeMeta } from './meta';
import type { DailyThemeMeta } from './types';

// Every day's files, found by directory name, so adding a day touches only its
// own directory. Each is a lazy chunk: nothing of a day loads until the layer
// asks for it, and only for a person who turned the theme on. All three are
// read as text, never imported: a day is agent-written, so none of it runs as
// termag. meta.json is parsed and checked (meta.ts), the CSS applies under the
// day's scope, and the sprite runs only in its sandboxed frame (spriteFrame.ts).
const metas = import.meta.glob<string>('./*/meta.json', { query: '?raw', import: 'default' });
const styles = import.meta.glob<string>('./*/theme.css', { query: '?inline', import: 'default' });
// A sprite is source text, never imported: it runs only in the sandboxed frame (spriteFrame.ts).
const sprites = import.meta.glob<string>('./*/sprite.js', { query: '?raw', import: 'default' });

export interface DailyTheme {
  date: string;
  meta: DailyThemeMeta;
  css: string;
  /** sprite.js's source, for the sandboxed frame; null when the day has none. */
  sprite: string | null;
}

/** The dates that have a theme, oldest first. */
export function dailyThemeDates(): string[] {
  return Object.keys(metas)
    .map(path => path.split('/')[1])
    .filter(d => DAILY_THEME_DATE.test(d))
    .sort();
}

/** The theme for `date`, or null when that day has none (or it is incomplete). */
export async function loadDailyTheme(date: string): Promise<DailyTheme | null> {
  if (!DAILY_THEME_DATE.test(date)) return null;
  const loadMeta = metas[`./${date}/meta.json`];
  const loadCss = styles[`./${date}/theme.css`];
  if (!loadMeta || !loadCss) return null;
  const loadSprite = sprites[`./${date}/sprite.js`];
  const [metaText, css, sprite] = await Promise.all([loadMeta(), loadCss(), loadSprite ? loadSprite() : null]);
  const meta: DailyThemeMeta | null = parseDailyThemeMeta(metaText, date);
  if (!meta) {
    console.warn('[daily-theme] meta.json does not pass its checks', date);
    return null;
  }
  return { date, meta, css, sprite: sprite ?? null };
}
