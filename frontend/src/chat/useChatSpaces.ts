// The user's spaces and which boxes reach each, for the simple UI's New chat
// and sidebar (chat/chatSpaces.ts). Nothing is fetched while spaces-enabled
// is off, and a failed load reads as no spaces, so the simple UI behaves as
// it does without spaces. ChatApp loads them once and shares them
// (ChatSpacesProvider), so the sidebar and the chat header agree.
import { createContext, createElement, useContext, useEffect, useState, type ReactNode } from 'react';
import { FLAGS, useFlag } from '../flags';
import { spacesApi, type SpaceView } from '../services/api';
import { boxSpaceIndex } from './chatSpaces';
import { spaceColor, type SpaceColorOf } from './spaceColors';

export interface ChatSpaces {
  enabled: boolean;
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
}

interface Loaded { loaded: boolean; spaces: SpaceView[]; index: Map<string, string[]>; forKey: string | null }

const EMPTY: Loaded = { loaded: false, spaces: [], index: new Map(), forKey: null };

/** `reloadKey` changing (for example the set of the user's boxes) loads again. */
export function useChatSpaces(opts: { withBoxes: boolean; reloadKey?: string }): ChatSpaces {
  const enabled = useFlag(FLAGS.spaces, false);
  const [state, setState] = useState(EMPTY);
  const key = opts.reloadKey ?? '';
  useEffect(() => {
    if (!enabled) { setState(EMPTY); return; }
    let cancelled = false;
    (async () => {
      const { spaces } = await spacesApi.list();
      const entries = opts.withBoxes
        ? await Promise.all(spaces.map(async s => ({ space: s.name, boxes: (await spacesApi.boxes(s.name).catch(() => ({ boxes: [] }))).boxes })))
        : [];
      if (!cancelled) setState({ loaded: true, spaces, index: boxSpaceIndex(entries), forKey: key });
    })().catch(() => { if (!cancelled) setState({ ...EMPTY, loaded: true, forKey: key }); });
    return () => { cancelled = true; };
  }, [enabled, opts.withBoxes, key]);
  const { loaded, spaces, index, forKey } = state;
  return { enabled, loaded, spaces, index, current: loaded && forKey === key };
}

/** What ChatApp shares: the spaces, and each one's colour among them (spaceColors.spacePalette). */
export interface SharedChatSpaces extends ChatSpaces { colorOf: SpaceColorOf }

const Shared = createContext<SharedChatSpaces>({ enabled: false, loaded: false, spaces: [], index: new Map(), current: false, colorOf: spaceColor });

export function ChatSpacesProvider({ value, children }: { value: SharedChatSpaces; children: ReactNode }) {
  return createElement(Shared.Provider, { value }, children);
}

/** The spaces ChatApp loaded, with their boxes; none outside a ChatSpacesProvider. */
export function useSharedChatSpaces(): SharedChatSpaces {
  return useContext(Shared);
}
