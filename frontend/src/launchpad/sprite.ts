/// <reference types="vite/client" />
// LaunchPad's Icon draws `<use href="#lp-icon-…">`, so its sprite has to be in
// the document once (docs/agents/gotchas.md, LaunchPad). It is fetched from
// termag's own assets and put in the body, hidden, the first time something
// that needs it mounts (generative UI's Select, Table sort, Disclosure and
// Alert, and the simple UI with its chrome refresh on), so a page with no
// LaunchPad icon never loads it. The file is the
// installed package's (about 212 KB, gzipped by the server).
import spriteUrl from '@launchpad-ui/icons/sprite.svg?url';

const SPRITE_ID = 'lp-icons-sprite';
let loading: Promise<void> | null = null;

/** Puts the sprite in the document; resolves once it is there. A failed fetch is tried again by the next call. */
export function ensureLaunchPadSprite(): Promise<void> {
  if (typeof document === 'undefined' || document.getElementById(SPRITE_ID)) return Promise.resolve();
  loading ??= fetch(spriteUrl)
    .then(r => (r.ok ? r.text() : Promise.reject(new Error(`sprite ${r.status}`))))
    .then(text => {
      if (document.getElementById(SPRITE_ID)) return;
      const svg = new DOMParser().parseFromString(text, 'image/svg+xml').documentElement;
      if (svg.nodeName.toLowerCase() !== 'svg') throw new Error('sprite is not an svg');
      svg.id = SPRITE_ID;
      svg.setAttribute('aria-hidden', 'true');
      svg.style.display = 'none';
      document.body.appendChild(svg);
    })
    .catch(() => { loading = null; });
  return loading;
}
