// A palette colour with an alpha, in a form xterm's canvas can parse
// (components/Terminal.tsx paints its background a little see-through). The
// palette's colours are CSS values read with getComputedStyle: usually
// '#rrggbb', but a theme or a surface may set '#rgb', 'rgb(…)' or 'rgba(…)'.
// Appending an alpha's hex digits only works on the first, so each form is
// handled; anything else is returned as it is, opaque rather than broken.

/** `color` with `alpha` (0-255) in place of its own. */
export function withAlpha(color: string, alpha: number): string {
  const a = Math.max(0, Math.min(255, Math.round(alpha)));
  const c = color.trim();
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(c);
  if (hex) {
    let digits = hex[1];
    if (digits.length <= 4) digits = digits.slice(0, 3).split('').map(d => d + d).join('');
    return `#${digits.slice(0, 6)}${a.toString(16).padStart(2, '0')}`;
  }
  const rgb = /^rgba?\(\s*([\d.]+%?)[\s,]+([\d.]+%?)[\s,]+([\d.]+%?)(?:\s*[,/]\s*[\d.]+%?)?\s*\)$/i.exec(c);
  if (rgb) {
    const channel = (v: string) => (v.endsWith('%') ? Math.round((parseFloat(v) * 255) / 100) : Math.round(parseFloat(v)));
    const alphaText = Number((a / 255).toFixed(3));
    return `rgba(${channel(rgb[1])}, ${channel(rgb[2])}, ${channel(rgb[3])}, ${alphaText})`;
  }
  return c;
}
