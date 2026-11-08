// The shape of one day's theme. A day is a directory
// named for its Pacific date, YYYY-MM-DD, next to this file:
//
//   meta.json   a DailyThemeMeta, as JSON (required; read as data, meta.ts)
//   theme.css   CSS, every selector under html[data-daily-theme="<date>"] (required)
//   sprite.js   export default a DailySprite, run in a sandboxed frame (optional):
//               plain JavaScript, no imports (spriteFrame.ts)
//
// The theme-of-the-day skill (.claude/skills/theme-of-the-day/) writes these;
// lint.ts holds them to the rules, and lint.test.ts runs it over every day.

export interface DailyThemeSource {
  /** What the link is, shown as its text: "Wikipedia: On this day, November 5". */
  label: string;
  /** An https URL. */
  url: string;
}

export interface DailyThemeMeta {
  /** The directory's date again, so a copied directory with a stale meta fails the lint. */
  date: string;
  /** A few words, shown in Settings → Appearance: "First rain of the season". */
  title: string;
  /** One or two plain sentences on why the day looks like this. Text, never HTML. */
  blurb: string;
  /** Where the research came from, 1 to 6 links. */
  sources: DailyThemeSource[];
}

/** What a sprite is told when it starts and on every resize. Sizes are CSS pixels. */
export interface SpriteEnv {
  width: number;
  height: number;
  palette: 'dark' | 'light';
  /** With reduced motion only one frame is drawn (time 0), and again on a resize. */
  reducedMotion: boolean;
}

export interface SpriteFrame extends SpriteEnv {
  ctx: CanvasRenderingContext2D;
  /** Milliseconds since the sprite started. */
  time: number;
  /** Milliseconds since the last frame (0 on the first). */
  dt: number;
}

export interface SpriteInstance {
  /** Draw one frame. The canvas is cleared before each call. */
  draw(frame: SpriteFrame): void;
  /** The canvas changed size or palette; keep or rebuild state. */
  resize?(env: SpriteEnv): void;
}

export interface DailySprite {
  /** How opaque the whole layer is, 0 to 1. Capped at MAX_DECOR_OPACITY. Default 0.6. */
  opacity?: number;
  /** Frames per second. Capped at MAX_DECOR_FPS. Default 24. */
  fps?: number;
  create(env: SpriteEnv): SpriteInstance;
}

// The frame sits above the page with pointer-events: none, so these caps are
// what keeps a sprite from hiding the UI or burning a laptop's battery. The
// opacity cap is the page's (DailyDecor); the frame rate is the frame's own
// runner's, so a sprite could defeat that one, but only by burning CPU.
export const MAX_DECOR_OPACITY = 0.7;
export const MAX_DECOR_FPS = 30;
