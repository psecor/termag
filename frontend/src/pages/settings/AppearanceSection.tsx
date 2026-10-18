import React, { useEffect, useRef, useState } from 'react';
import { useTheme } from '../../theme/ThemeProvider';
import { BASE_BACKGROUND_COLOR, DEFAULT_THEME, ThemeSettings, normalizeHexColor } from '../../theme/schema';
import { DocsLink } from './DocsLink';

// Solid backdrops that read well under the light-on-dark text. The first is
// the base colour the starfield fades to, so picking "Solid color" stops the
// stars without changing the look.
const PRESETS: { color: string; name: string }[] = [
  { color: BASE_BACKGROUND_COLOR, name: 'Default' },
  { color: '#000000', name: 'Black' },
  { color: '#0b1a2e', name: 'Navy' },
  { color: '#111827', name: 'Slate' },
  { color: '#1a1026', name: 'Plum' },
  { color: '#0f1f17', name: 'Forest' },
  { color: '#1f1510', name: 'Umber' },
];

// A colour-picker drag fires a change per pixel; persist once the hand stops.
const SAVE_DEBOUNCE_MS = 400;

function apiError(err: unknown, fallback: string): string {
  return (err as { response?: { data?: { error?: string } } })?.response?.data?.error || fallback;
}

function sameTheme(a: ThemeSettings, b: ThemeSettings): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Settings → Appearance: the workspace background (the hyperspace starfield
 * or a solid colour), whether the sidebar footer shows the activity
 * indicators, and whether the project list offers MetaTerm. Later theme axes (palette, terminal colours) become further
 * groups in this section.
 */
export function AppearanceSection() {
  const { theme, saved, preview, save, saving } = useTheme();
  const [error, setError] = useState('');
  // The colour "Solid color" returns to after a spell on the starfield. It
  // follows the colour on screen (saved or previewed) rather than each pick,
  // so a save that fails never leaves it holding a colour that was neither.
  const [solidColor, setSolidColor] = useState(
    saved.background.mode === 'solid' ? saved.background.color : BASE_BACKGROUND_COLOR,
  );
  useEffect(() => {
    if (theme.background.mode === 'solid') setSolidColor(theme.background.color);
  }, [theme]);
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
  const shownColor = theme.background.mode === 'solid' ? theme.background.color : solidColor;

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

  function solid(color: string): ThemeSettings {
    return { ...theme, background: { mode: 'solid', color } };
  }

  function chooseMode(next: 'hyperspace' | 'solid') {
    void commit(next === 'solid' ? solid(solidColor) : { ...theme, background: { mode: 'hyperspace' } });
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
        <p className="settings-hint">
          What sits behind the workspace. The sidebar and terminals are translucent, so a solid
          color tints the whole page. Your browser's reduced-motion setting freezes the starfield;
          a solid color removes it.
        </p>
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
              <span className="settings-row-meta">Speeds up with agent activity.</span>
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
                {PRESETS.map(p => (
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
        {!sameTheme(saved, DEFAULT_THEME) && (
          <button type="button" className="settings-link" disabled={saving} onClick={() => void commit(DEFAULT_THEME)}>
            Reset to defaults
          </button>
        )}
      </div>
    </section>
  );
}
