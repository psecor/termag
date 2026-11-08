import React, { useEffect, useRef, useState } from 'react';
import { FLAGS, useFlag } from '../../flags';
import { useTheme } from '../../theme/ThemeProvider';
import { themePalette } from '../../theme/apply';
import { BASE_BACKGROUND_COLORS, DEFAULT_THEME, TerminalFont, ThemePalette, ThemeSettings, normalizeHexColor } from '../../theme/schema';
import { terminalFontFamily } from '../../components/terminalFont';
import { DocsLink } from './DocsLink';
import { useDailyTheme } from '../../theme/daily/useDailyTheme';

// Solid backdrops that read well under each palette's text. The first is the
// palette's base (in dark, the colour the starfield fades to), so picking
// "Solid color" changes nothing but stopping the stars. A colour the user
// saved applies as it is in either palette; only the offer changes.
const PRESETS: Record<ThemePalette, { color: string; name: string }[]> = {
  dark: [
    { color: BASE_BACKGROUND_COLORS.dark, name: 'Default' },
    { color: '#000000', name: 'Black' },
    { color: '#0b1a2e', name: 'Navy' },
    { color: '#111827', name: 'Slate' },
    { color: '#1a1026', name: 'Plum' },
    { color: '#0f1f17', name: 'Forest' },
    { color: '#1f1510', name: 'Umber' },
  ],
  light: [
    { color: BASE_BACKGROUND_COLORS.light, name: 'Default' },
    { color: '#f6f8fa', name: 'Paper' },
    { color: '#eef1f5', name: 'Mist' },
    { color: '#e7f0fa', name: 'Sky' },
    { color: '#f0ecf8', name: 'Lavender' },
    { color: '#e8f4ec', name: 'Mint' },
    { color: '#f6f0e6', name: 'Sand' },
  ],
};

// A colour-picker drag fires a change per pixel; persist once the hand stops.
const SAVE_DEBOUNCE_MS = 400;

function apiError(err: unknown, fallback: string): string {
  return (err as { response?: { data?: { error?: string } } })?.response?.data?.error || fallback;
}

function sameTheme(a: ThemeSettings, b: ThemeSettings): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// Reset sends an explicit dark palette, no turkeys, no theme of the day and
// Maple Mono: the server fills a theme's absent optional keys from the stored
// one, so DEFAULT_THEME alone would keep light (and the turkeys, the theme of
// the day, and JetBrains Mono).
const RESET_THEME: ThemeSettings = { ...DEFAULT_THEME, palette: 'dark', starfieldTurkeys: false, dailyTheme: false, terminalFont: 'maple' };

// Each choice shows a line of terminal text in its own face, italic included:
// the italic is where the two differ most (Maple Mono's is cursive).
const TERMINAL_FONTS: { value: TerminalFont; name: string; meta: string }[] = [
  { value: 'maple', name: 'Maple Mono', meta: 'Rounder, with a cursive italic. The default.' },
  { value: 'jetbrains', name: 'JetBrains Mono', meta: 'The face of code blocks and the file viewer, with a plain slanted italic.' },
];

/**
 * Settings → Appearance: the palette (dark or light, behind
 * light-mode-enabled), the workspace background (the hyperspace starfield
 * or a solid colour), the font terminals are set in, whether the sidebar
 * footer shows the activity indicators, whether the project list offers MetaTerm, and whether it leaves
 * out the boxes and projects made for `termag ask`, and (behind
 * thanksgiving-turkeys-enabled) whether the starfield flies turkeys, and (behind
 * daily-theme-enabled) whether today's theme of the day applies. Later theme axes
 * (terminal colours) become further groups in this section.
 */
export function AppearanceSection() {
  const { theme, saved, preview, save, saving } = useTheme();
  const lightModeEnabled = useFlag(FLAGS.lightMode, false);
  const turkeysEnabled = useFlag(FLAGS.thanksgivingTurkeys, false);
  const dailyThemeEnabled = useFlag(FLAGS.dailyTheme, false);
  const today = useDailyTheme(dailyThemeEnabled, theme.dailyTheme === true);
  const [error, setError] = useState('');
  const palette = themePalette(theme);
  // The colour "Solid color" returns to after a spell on the starfield. It
  // follows the colour on screen (saved or previewed) rather than each pick,
  // so a save that fails never leaves it holding a colour that was neither.
  // Null until there is one: the palette's base, which follows a palette switch.
  const [solidColor, setSolidColor] = useState<string | null>(
    saved.background.mode === 'solid' ? saved.background.color : null,
  );
  useEffect(() => {
    if (theme.background.mode === 'solid') setSolidColor(theme.background.color);
  }, [theme]);
  const returnColor = solidColor ?? BASE_BACKGROUND_COLORS[palette];
  // The hex field while it is being edited; null means it mirrors the colour
  // on screen, so when a failed save drops the preview the field follows.
  const [hexDraft, setHexDraft] = useState<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function cancelPendingSave() {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = null;
  }

  // Leaving the page ends a preview that was never saved.
  useEffect(() => () => {
    cancelPendingSave();
    preview(null);
  }, [preview]);

  const mode = theme.background.mode;
  const shownColor = theme.background.mode === 'solid' ? theme.background.color : returnColor;

  // Every save, Reset included, supersedes a colour drag still waiting out its
  // debounce; otherwise that timer would fire afterwards and undo this save.
  async function commit(next: ThemeSettings) {
    cancelPendingSave();
    setError('');
    try {
      await save(next);
    } catch (err) {
      setError(apiError(err, 'Failed to save appearance'));
    }
  }

  // Sent explicitly for dark too, so the server's merge cannot keep a stored light.
  function choosePalette(next: ThemePalette) {
    void commit({ ...theme, palette: next });
  }

  // Sent explicitly for Maple Mono too, for the same reason. Terminals read
  // it when they open, which is on the way back from this page (Terminal.tsx).
  function chooseTerminalFont(next: TerminalFont) {
    void commit({ ...theme, terminalFont: next });
  }
  const terminalFont: TerminalFont = theme.terminalFont ?? 'maple';

  function solid(color: string): ThemeSettings {
    return { ...theme, background: { mode: 'solid', color } };
  }

  function chooseMode(next: 'hyperspace' | 'solid') {
    void commit(next === 'solid' ? solid(returnColor) : { ...theme, background: { mode: 'hyperspace' } });
  }

  // `immediate` saves now (swatch, hex field); otherwise preview and save after the drag settles.
  function pickColor(color: string, immediate: boolean) {
    setHexDraft(null);
    const next = solid(color);
    if (immediate) {
      void commit(next);
      return;
    }
    cancelPendingSave();
    preview(next);
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null;
      void commit(next);
    }, SAVE_DEBOUNCE_MS);
  }

  function commitHex() {
    const color = hexDraft === null ? null : normalizeHexColor(hexDraft);
    setHexDraft(null);
    if (color && color !== shownColor) pickColor(color, true);
  }

  return (
    <section className="dash-section" aria-labelledby="appearance-h">
      <div className="dash-section-title" id="appearance-h">
        Appearance <DocsLink anchor="appearance" topic="Appearance" />
      </div>
      <div className="dash-card">
        {lightModeEnabled && (
          <div className="settings-choice" role="radiogroup" aria-label="Palette">
            {([
              ['dark', 'Dark', 'Light text on a dark page.'],
              ['light', 'Light', 'Dark text on a light page.'],
            ] as const).map(([value, name, meta]) => (
              <label key={value} className="settings-radio" data-checked={palette === value || undefined}>
                <input
                  type="radio"
                  name="palette"
                  checked={palette === value}
                  disabled={saving}
                  onChange={() => choosePalette(value)}
                />
                <span className="settings-row-text">
                  <span className="settings-row-name">{name}</span>
                  <span className="settings-row-meta">{meta}</span>
                </span>
              </label>
            ))}
          </div>
        )}
        {palette === 'light' ? (
          <p className="settings-hint">
            What sits behind the workspace. The sidebar is translucent, so a solid color tints the
            page; terminals stay dark. The starfield is drawn in the dark palette only.
          </p>
        ) : (
          <p className="settings-hint">
            What sits behind the workspace. The sidebar and terminals are translucent, so a solid
            color tints the whole page. Your browser's reduced-motion setting freezes the starfield;
            a solid color removes it.
          </p>
        )}
        {error && <div className="error-banner">{error}<button onClick={() => setError('')}>×</button></div>}
        <div className="settings-choice" role="radiogroup" aria-label="Background">
          <label className="settings-radio" data-checked={mode === 'hyperspace' || undefined}>
            <input
              type="radio"
              name="background-mode"
              checked={mode === 'hyperspace'}
              disabled={saving}
              onChange={() => chooseMode('hyperspace')}
            />
            <span className="settings-row-text">
              <span className="settings-row-name">Hyperspace starfield</span>
              <span className="settings-row-meta">
                {palette === 'light'
                  ? 'Speeds up with agent activity. Dark palette only: light shows a plain backdrop.'
                  : 'Speeds up with agent activity.'}
              </span>
            </span>
          </label>
          <label className="settings-radio" data-checked={mode === 'solid' || undefined}>
            <input
              type="radio"
              name="background-mode"
              checked={mode === 'solid'}
              disabled={saving}
              onChange={() => chooseMode('solid')}
            />
            <span className="settings-row-text">
              <span className="settings-row-name">Solid color</span>
              <span className="settings-row-meta">A fixed backdrop of your choice.</span>
            </span>
          </label>
        </div>
        {mode === 'hyperspace' && turkeysEnabled && (
          <div className="settings-choice">
            <label className="settings-radio" data-checked={theme.starfieldTurkeys || undefined}>
              <input
                type="checkbox"
                checked={theme.starfieldTurkeys === true}
                disabled={saving}
                onChange={e => void commit({ ...theme, starfieldTurkeys: e.target.checked })}
              />
              <span className="settings-row-text">
                <span className="settings-row-name">Thanksgiving turkeys</span>
                <span className="settings-row-meta">
                  Swaps the starfield's stars for little turkeys, flying faster as your agents work.
                </span>
              </span>
            </label>
          </div>
        )}
        {mode === 'solid' && (
          <div className="settings-color">
            <div className="settings-color-row">
              <input
                type="color"
                value={shownColor}
                aria-label="Background color"
                onChange={e => pickColor(e.target.value, false)}
              />
              <input
                type="text"
                className="settings-hex"
                value={hexDraft ?? shownColor}
                aria-label="Background color as hex"
                spellCheck={false}
                maxLength={7}
                onChange={e => setHexDraft(e.target.value)}
                onBlur={commitHex}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commitHex(); } }}
              />
              <div className="settings-swatches" role="list" aria-label="Preset colors">
                {PRESETS[palette].map(p => (
                  <button
                    key={p.color}
                    type="button"
                    role="listitem"
                    className="settings-swatch"
                    title={`${p.name} ${p.color}`}
                    aria-label={`${p.name} ${p.color}`}
                    style={{ background: p.color }}
                    data-selected={p.color === shownColor || undefined}
                    onClick={() => pickColor(p.color, true)}
                  />
                ))}
              </div>
            </div>
            <div className="settings-preview" style={{ background: shownColor }} aria-hidden="true">
              <div className="settings-preview-sidebar" />
              <div className="settings-preview-pane">$ the sidebar and terminals tint over this color</div>
            </div>
          </div>
        )}
        {dailyThemeEnabled && (
          <div className="settings-choice">
            <label className="settings-radio" data-checked={theme.dailyTheme || undefined}>
              <input
                type="checkbox"
                checked={theme.dailyTheme === true}
                disabled={saving}
                onChange={e => void commit({ ...theme, dailyTheme: e.target.checked })}
              />
              <span className="settings-row-text">
                <span className="settings-row-name">Theme of the day</span>
                <span className="settings-row-meta">
                  A new look most days, inspired by the season, Oakland's weather and what happened on this date. Colours, and sometimes a little animation.
                </span>
              </span>
            </label>
            {theme.dailyTheme === true && today.status !== 'loading' && (
              <p className="settings-hint" data-testid="daily-theme-today">
                {today.theme ? (
                  <>
                    Today: <strong>{today.theme.meta.title}</strong>. {today.theme.meta.blurb}{' '}
                    {today.theme.meta.sources.map((src, i) => (
                      <React.Fragment key={src.url}>
                        {i > 0 && ', '}
                        <a href={src.url} target="_blank" rel="noopener noreferrer">{src.label}</a>
                      </React.Fragment>
                    ))}
                  </>
                ) : (
                  'No theme today, so you get the usual look.'
                )}
              </p>
            )}
          </div>
        )}
        <div className="settings-choice" role="radiogroup" aria-label="Terminal font">
          <p className="settings-hint">The font terminals are set in. Code blocks and the file viewer stay in JetBrains Mono.</p>
          {TERMINAL_FONTS.map(f => (
            <label key={f.value} className="settings-radio" data-checked={terminalFont === f.value || undefined}>
              <input
                type="radio"
                name="terminal-font"
                checked={terminalFont === f.value}
                disabled={saving}
                onChange={() => chooseTerminalFont(f.value)}
              />
              <span className="settings-row-text">
                <span className="settings-row-name">{f.name}</span>
                <span className="settings-row-meta">{f.meta}</span>
                <span
                  className="settings-font-sample"
                  aria-hidden="true"
                  style={{ fontFamily: terminalFontFamily('var(--font-mono)', f.value) }}
                >
                  $ git log --oneline <i>fell back to the cache</i>
                </span>
              </span>
            </label>
          ))}
        </div>
        <div className="settings-choice">
          <label className="settings-radio" data-checked={theme.sidebarActivity || undefined}>
            <input
              type="checkbox"
              checked={theme.sidebarActivity}
              disabled={saving}
              onChange={e => void commit({ ...theme, sidebarActivity: e.target.checked })}
            />
            <span className="settings-row-text">
              <span className="settings-row-name">Show activity in the sidebar</span>
              <span className="settings-row-meta">
                Today's working-time thermometer (agents and you) and the warp-speed readout.
              </span>
            </span>
          </label>
        </div>
        <div className="settings-choice">
          <label className="settings-radio" data-checked={theme.sidebarMetaTerm || undefined}>
            <input
              type="checkbox"
              checked={theme.sidebarMetaTerm}
              disabled={saving}
              onChange={e => void commit({ ...theme, sidebarMetaTerm: e.target.checked })}
            />
            <span className="settings-row-text">
              <span className="settings-row-name">Show MetaTerm in the sidebar</span>
              <span className="settings-row-meta">
                A Claude on the orchestrator that can read your sessions on every box. It is not a place to do project work; use a project on a box for that.
              </span>
            </span>
          </label>
        </div>
        <div className="settings-choice">
          <label className="settings-radio" data-checked={theme.sidebarHideAskBoxes || undefined}>
            <input
              type="checkbox"
              checked={theme.sidebarHideAskBoxes}
              disabled={saving}
              onChange={e => void commit({ ...theme, sidebarHideAskBoxes: e.target.checked })}
            />
            <span className="settings-row-text">
              <span className="settings-row-name">Hide ask boxes from the Projects list</span>
              <span className="settings-row-meta">
                Leaves out the boxes and projects <code>termag ask --new-box</code> makes, so the list shows only
                what you started. Nothing happens to them: Boxes and search still list them, and the project you
                have open stays.
              </span>
            </span>
          </label>
        </div>
        <div className="settings-choice">
          <label className="settings-radio" data-checked={theme.sidebarAskChats || undefined}>
            <input
              type="checkbox"
              checked={theme.sidebarAskChats}
              disabled={saving}
              onChange={e => void commit({ ...theme, sidebarAskChats: e.target.checked })}
            />
            <span className="settings-row-text">
              <span className="settings-row-name">Show ask sessions in the workspace</span>
              <span className="settings-row-meta">
                The ask-… sessions the chat UI makes when one agent asks another. They have no terminal pane here — read and reply to them in the chat UI.
              </span>
            </span>
          </label>
        </div>
        {!sameTheme(saved, DEFAULT_THEME) && (
          <button type="button" className="settings-link" disabled={saving} onClick={() => void commit(RESET_THEME)}>
            Reset to defaults
          </button>
        )}
      </div>
    </section>
  );
}
