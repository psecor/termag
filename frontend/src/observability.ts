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

// Product events and custom events go to whatever recorder a deployment adds;
// termag ships none, so these are no-ops that keep their call sites.
export type BrowserProductEvent =
  | 'welcome.viewed' | 'sshkey.added' | 'first.prompt'
  // The redrawn first run's funnel, under onboarding-refresh-enabled.
  | 'welcome.step' | 'welcome.github.connected' | 'welcome.dotfiles.saved' | 'welcome.mode.chosen' | 'welcome.finished'
  // Which client and view, and the chat UI's commands (usageEvents.ts).
  | 'client.opened' | 'ui.mode.switched' | 'app.install.prompted' | 'app.installed' | 'chat.command';
export type ProductEventAttributes = Record<string, string | number | boolean>;

export function recordProductEvent(_name: BrowserProductEvent, _attributes: ProductEventAttributes = {}): void {}

// Once per page load: `first.prompt` is the first prompt this tab sends to an
// agent, not every one.
const recordedOnce = new Set<BrowserProductEvent>();
export function recordProductEventOnce(name: BrowserProductEvent, attributes: ProductEventAttributes = {}): boolean {
  if (recordedOnce.has(name)) return false;
  recordedOnce.add(name);
  recordProductEvent(name, attributes);
  return true;
}

/** Test hook: forget what this page recorded once. */
export function resetProductEventsForTests(): void {
  recordedOnce.clear();
}

export function trackEvent(_key: string, _data?: Record<string, string | number | boolean>): void {}
