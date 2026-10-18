// Runs saves one at a time, in the order they were requested.
//
// Two theme saves can overlap: a colour drag's debounced save landing just
// after a Reset, or a swatch click while the previous save is in flight. Sent
// concurrently, the server applies whichever request arrives last and the
// browser shows whichever response arrives last, and those need not agree.
// Serializing them makes the last request win on both sides, and `onDrain`
// fires once the queue is empty so a live preview is cleared only when the
// saved theme is the one the user asked for last.
export interface SaveQueue<T> {
  /** Enqueue a save. Resolves or rejects with the underlying run; a failure does not block later saves. */
  push(item: T): Promise<void>;
  /** Saves requested but not yet settled. */
  readonly pending: number;
}

export function createSaveQueue<T>(run: (item: T) => Promise<void>, onDrain: () => void): SaveQueue<T> {
  let chain: Promise<void> = Promise.resolve();
  let pending = 0;
  return {
    push(item: T): Promise<void> {
      pending += 1;
      const result = chain.then(() => run(item));
      chain = result.catch(() => undefined);
      return result.finally(() => {
        pending -= 1;
        if (pending === 0) onDrain();
      });
    },
    get pending() {
      return pending;
    },
  };
}
