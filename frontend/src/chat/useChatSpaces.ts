// The user's spaces and which boxes reach each, for the simple UI's New chat
// and sidebar (chat/chatSpaces.ts). A failed load reads as no spaces, so the simple UI behaves as
// it does without spaces. ChatApp loads them once and shares them
// (ChatSpacesProvider), so the sidebar and the chat header agree.
import { createContext, createElement, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { spacesApi, type SpaceView } from '../services/api';
import { boxSpaceIndex } from './chatSpaces';
import { spaceColor, type SpaceColorOf } from './spaceColors';

export interface ChatSpaces {
  loaded: boolean;
  spaces: SpaceView[];
  /** Box id → the spaces it reaches (chatSpaces.boxSpaceIndex). */
  index: Map<string, string[]>;
  /**
   * The index was loaded for the current `reloadKey`. While a new box's
   * reload is in flight the old index is kept but lacks that box, so its
   * absence means "not known yet", not "in no space".
   */
  current: boolean;
  /** Load again: someone was added to or removed from a space, or a box was. */
  reload?: () => void;
}

interface Loaded { loaded: boolean; spaces: SpaceView[]; index: Map<string, string[]>; forKey: string | null }

const EMPTY: Loaded = { loaded: false, spaces: [], index: new Map(), forKey: null };

/** `reloadKey` changing (for example the set of the user's boxes) loads again. */
export function useChatSpaces(opts: { withBoxes: boolean; reloadKey?: string }): ChatSpaces {
  const [state, setState] = useState(EMPTY);
  const [generation, setGeneration] = useState(0);
  const reload = useCallback(() => setGeneration(g => g + 1), []);
  const key = opts.reloadKey ?? '';
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { spaces } = await spacesApi.list();
      const entries = opts.withBoxes
        ? await Promise.all(spaces.map(async s => ({ space: s.name, ...await spacesApi.boxes(s.name).catch(() => ({ boxes: [] })) })))
        : [];
      if (!cancelled) setState({ loaded: true, spaces, index: boxSpaceIndex(entries), forKey: key });
    // A failed first load reads as no spaces, as the simple UI is without them; a failed
    // reload (say after a change in the Share dialog) keeps what was loaded.
    })().catch(() => { if (!cancelled) setState(s => (s.loaded && s.forKey !== null ? s : { ...EMPTY, loaded: true, forKey: key })); });
    return () => { cancelled = true; };
  }, [opts.withBoxes, key, generation]);
  const { loaded, spaces, index, forKey } = state;
  return { loaded, spaces, index, current: loaded && forKey === key, reload };
}

/** What ChatApp shares: the spaces, and each one's colour among them (spaceColors.spacePalette). */
export interface SharedChatSpaces extends ChatSpaces { colorOf: SpaceColorOf }

const NONE: SharedChatSpaces = { loaded: false, spaces: [], index: new Map(), current: false, colorOf: spaceColor };
const Shared = createContext<SharedChatSpaces>(NONE);

export function ChatSpacesProvider({ value, children }: { value: SharedChatSpaces; children: ReactNode }) {
  return createElement(Shared.Provider, { value }, children);
}

/** The spaces ChatApp loaded, with their boxes; none outside a ChatSpacesProvider. */
export function useSharedChatSpaces(): SharedChatSpaces {
  return useContext(Shared);
}

/**
 * `value` once ChatApp's spaces have loaded: at once if they have (or there
 * is no ChatSpacesProvider), else when they land, as `value` is then, or null
 * if they haven't after `waitMs`. A wait still open when the chat (`key`)
 * changes or unmounts fails instead, so nothing meant for it goes elsewhere.
 */
export function useWhenSpacesLoaded<T>(value: T, key: string, waitMs = 15_000): () => Promise<T | null> {
  const shared = useContext(Shared);
  const loaded = shared.loaded || shared === NONE;
  const latest = useRef({ loaded, value });
  latest.current = { loaded, value };
  const waiters = useRef(new Set<(left: boolean) => void>());
  useEffect(() => {
    if (loaded) for (const done of [...waiters.current]) done(false);
  }, [loaded, value]);
  useEffect(() => () => { for (const done of [...waiters.current]) done(true); }, [key]);
  return useCallback(() => latest.current.loaded ? Promise.resolve(latest.current.value) : new Promise<T | null>((resolve, reject) => {
    const done = (left: boolean) => {
      clearTimeout(timer);
      waiters.current.delete(done);
      if (left) reject(new Error('the chat closed before its spaces loaded'));
      else resolve(latest.current.loaded ? latest.current.value : null);
    };
    const timer = setTimeout(() => done(false), waitMs);
    waiters.current.add(done);
  }), [waitMs]);
}
