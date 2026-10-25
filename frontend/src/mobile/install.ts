// "Install app". Chromium fires `beforeinstallprompt`
// once, early in the page's life, and the event must be kept to prompt later
// from a tap — so this module is imported by main.tsx and starts listening
// before React (and the lazy /m chunk) exists. iOS Safari has no prompt; the
// phone client shows how to Add to Home Screen instead.
import { isAppleMobile, isStandalone } from './redirect';

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferred: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach(l => l());

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e as BeforeInstallPromptEvent;
    notify();
  });
  window.addEventListener('appinstalled', () => { deferred = null; notify(); });
}

export type InstallOption =
  /** Already running as the installed app. */
  | 'installed'
  /** The browser handed us a prompt: one tap installs. */
  | 'prompt'
  /** iOS / iPadOS Safari: Share → Add to Home Screen. */
  | 'ios-instructions'
  /** Nothing to offer (a desktop browser without the prompt, or one already dismissed). */
  | 'none';

export function installOption(env: { standalone: boolean; hasPrompt: boolean; appleMobile: boolean }): InstallOption {
  if (env.standalone) return 'installed';
  if (env.hasPrompt) return 'prompt';
  if (env.appleMobile) return 'ios-instructions';
  return 'none';
}

export function currentInstallOption(): InstallOption {
  if (typeof window === 'undefined') return 'none';
  return installOption({
    standalone: isStandalone(window),
    hasPrompt: deferred != null,
    appleMobile: isAppleMobile(navigator.userAgent, navigator.maxTouchPoints ?? 0),
  });
}

/** Show the browser's install prompt. The event is single-use either way. */
export async function promptInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
  const e = deferred;
  if (!e) return 'unavailable';
  deferred = null;
  notify();
  await e.prompt();
  return (await e.userChoice).outcome;
}

export function subscribeInstall(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
