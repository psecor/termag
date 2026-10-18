// Elements carrying this class are kept out of any session recording a
// deployment adds. termag ships no recorder; the class stays so pages that
// show secrets (tokens, settings) are already marked.
export const REPLAY_BLOCK_CLASS = 'replay-block';

// The id of the session recording this tab is making, which a project launch
// passes on so the agent's telemetry can be filed under it. termag ships no
// recorder, so there is none.
export async function replaySessionId(): Promise<string | null> {
  return null;
}
