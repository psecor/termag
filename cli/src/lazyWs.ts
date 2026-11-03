/**
 * Whether `err`, from a dynamic import, is `ws` failing to resolve: Node's
 * own error, or one wrapping it (vitest's module mocks do). install.sh's
 * `npm ci` empties node_modules first, so after a failed or killed reinstall
 * every command that doesn't need `ws` must still start, and the ones that do
 * say what is missing.
 */
export function isMissingWs(err: unknown): boolean {
  let e = err as (NodeJS.ErrnoException & { cause?: unknown }) | undefined;
  while (e && !(e.code === 'ERR_MODULE_NOT_FOUND' && String(e.message).includes("'ws'"))) e = e.cause as typeof e;
  return Boolean(e);
}
