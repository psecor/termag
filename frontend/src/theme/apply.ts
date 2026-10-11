import { BASE_BACKGROUND_COLOR, ThemeSettings } from './schema';

// The CSS custom properties a theme sets on <html>. One entry per themed
// surface: a later palette axis adds its --bg-* / --text-* overrides here and
// nowhere else, and App.css keeps reading variables.
export const BACKDROP_VAR = '--bg-backdrop';

export function themeCssVariables(theme: ThemeSettings): Record<string, string> {
  const bg = theme.background;
  return { [BACKDROP_VAR]: bg.mode === 'solid' ? bg.color : BASE_BACKGROUND_COLOR };
}

export interface StyleRoot { style: { setProperty(name: string, value: string): void } }

export function applyTheme(theme: ThemeSettings, root: StyleRoot): void {
  for (const [name, value] of Object.entries(themeCssVariables(theme))) root.style.setProperty(name, value);
}
