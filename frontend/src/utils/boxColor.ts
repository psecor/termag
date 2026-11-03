// Deterministic hue from a box's instance id so a project's "which box" stripe
// stays the same across reloads. Only the hue is the box's: saturation and
// lightness are App.css's --box-saturation and --box-lightness, set per
// palette so every hue keeps 3:1 against the surfaces it sits on (darker in
// light mode), and a palette switch needs no re-render. Returns null for
// legacy projects (instanceId === null) so they render with no stripe. The
// full UI's project rows and the simple UI's session rows use the same colour
// for a box.
export function boxHue(instanceId: string): number {
  let h = 0;
  for (let i = 0; i < instanceId.length; i++) {
    h = (h * 31 + instanceId.charCodeAt(i)) >>> 0;
  }
  return h % 360;
}

export function boxStripeColor(instanceId: string | null | undefined): string | null {
  if (!instanceId) return null;
  return `hsl(${boxHue(instanceId)}, var(--box-saturation), var(--box-lightness))`;
}
