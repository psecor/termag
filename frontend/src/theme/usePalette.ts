import { useSyncExternalStore } from 'react';
import { ThemePalette } from './schema';

// The live palette, read off html[data-palette] (theme/apply.ts sets it), for
// colours that live in JS rather than App.css: the provider registry's pairs.
// CSS-token colours (pages/dashboard/chartPalette.ts HUE) follow a toggle on
// their own; these re-render through the observer, so neither needs a reload.

export function currentPalette(root: { dataset: Record<string, string | undefined> } | null =
  typeof document === 'undefined' ? null : document.documentElement): ThemePalette {
  return root?.dataset.palette === 'light' ? 'light' : 'dark';
}

function subscribe(onChange: () => void): () => void {
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return () => {};
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-palette'] });
  return () => observer.disconnect();
}

export function usePalette(): ThemePalette {
  return useSyncExternalStore(subscribe, () => currentPalette(), () => 'dark');
}
