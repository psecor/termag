import type { WebSocket } from 'ws';

/**
 * Runs `setup` with the socket paused, so frames that arrive before the server
 * is ready to handle them are buffered instead of dropped.
 *
 * The WebSocket handshake completes before the backend knows who the peer is:
 * authentication is an async lookup that happens after the connection is live.
 * A peer that speaks first — the per-user agent sends `hello` from its own
 * `open` handler — would otherwise emit `message` while no listener is attached
 * yet, and `ws` discards those frames.
 */
export async function holdFramesUntilReady(
  ws: WebSocket,
  setup: () => Promise<void>,
): Promise<void> {
  ws.pause();
  try {
    await setup();
  } finally {
    try { ws.resume(); } catch {}
  }
}
