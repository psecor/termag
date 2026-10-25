// Deterministic hue from a box's instance id so a project's "which box" stripe
// stays the same across reloads. Fixed saturation/lightness keeps the visual
// weight consistent against the dark theme. Returns null for legacy projects
// (instanceId === null) so they render with no stripe. The full UI's project
// rows and the simple UI's session rows use the same colour for a box.
export function boxStripeColor(instanceId: string | null | undefined): string | null {
  if (!instanceId) return null;
  let h = 0;
  for (let i = 0; i < instanceId.length; i++) {
    h = (h * 31 + instanceId.charCodeAt(i)) >>> 0;
  }
  return `hsl(${h % 360}, 55%, 58%)`;
}
