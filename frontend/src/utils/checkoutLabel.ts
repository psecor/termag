/**
 * A checkout's directory on a box as its owner reads it: under a home
 * directory, `~/…` (`/home/olive/src/webapp` is `~/src/webapp`); anything
 * else as it is. A PR link share shows where it came from with this
 * (4d).
 */
export function checkoutLabel(dir: string): string {
  const m = /^\/(?:home\/[^/]+|root)\/(.+)$/.exec(dir);
  return m ? `~/${m[1]}` : dir;
}
