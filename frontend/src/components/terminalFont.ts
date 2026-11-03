// Terminals are set in Maple Mono, rounder than the JetBrains Mono of --font-mono,
// unless Settings → Appearance sets them in JetBrains Mono (ThemeSettings.terminalFont).
// Only terminals read this: --font-mono (code, paths, the file viewer) stays JetBrains Mono.
import '../fonts/maple-mono/maple-mono.css';
import type { TerminalFont } from '../theme/schema';

export const TERMINAL_FONT = "'Maple Mono'";

// The terminal's font-family: Maple Mono ahead of the --font-mono stack, so the
// stack still stands in while it loads and covers the glyphs it lacks. JetBrains
// Mono is the stack itself.
export function terminalFontFamily(monoStack: string, font: TerminalFont | undefined): string {
  return font === 'jetbrains' ? monoStack : `${TERMINAL_FONT}, ${monoStack}`;
}
