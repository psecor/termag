// New chat's space step as one hook, so the page only renders the picker and
// calls `prepare` before launching the box and `grant` once it has one
// (chat/chatSpaces.ts). Off (no picker, both calls no-ops) while
// spaces-enabled is off.
import { useRef, useState } from 'react';
import { spacesApi } from '../services/api';
import { ensureSpace, grantBox, initialSpaceChoice, NO_SPACE, spaceChoiceError, type SpaceChoice, type SpaceGrantApi } from './chatSpaces';
import { useChatSpaces } from './useChatSpaces';

const api: SpaceGrantApi = {
  create: name => spacesApi.create(name),
  addBox: (space, box) => spacesApi.addBox(space, box),
};

function apiError(err: unknown, fallback: string): string {
  return (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? fallback;
}

/** `remembered` is the space the last chat went in, used when `?space=` names none the user can pick. */
export function useSpaceStep(requested: string | null, remembered: string | null = null) {
  const { enabled, loaded, spaces } = useChatSpaces({ withBoxes: false });
  const [picked, setPicked] = useState<SpaceChoice | null>(null);
  const [created, setCreated] = useState<ReadonlySet<string>>(new Set());
  const createdRef = useRef(created);
  createdRef.current = created;

  // Derived, not set in an effect, so the render that first sees the list already holds `?space=` (or the remembered space).
  const choice = picked ?? (loaded ? initialSpaceChoice(requested, spaces, remembered) : NO_SPACE);
  const active = enabled && loaded;
  const error = active ? spaceChoiceError(choice, spaces, created) : '';

  return {
    /** Render the picker. */
    show: active,
    /** False while spaces-enabled is on and the list has not loaded: Start must wait. */
    ready: !enabled || loaded,
    pickerProps: {
      value: choice,
      spaces,
      onChange: (next: SpaceChoice) => setPicked(next),
    },
    /** A choice that should block Start ('' when none). Only shown once the user has picked. */
    error,
    /** The space the chat goes in, created now if new; null for none. Throws an Error with the message to show. */
    async prepare(): Promise<string | null> {
      if (!enabled) return null;
      if (!loaded) throw new Error('Your spaces are still loading');
      try {
        return await ensureSpace(choice, createdRef.current, api, name => {
          const next = new Set(createdRef.current).add(name);
          createdRef.current = next;
          setCreated(next);
        });
      } catch (err) {
        throw new Error(apiError(err, 'Could not create the space'));
      }
    },
    /** Gives the new box access to `space`. Throws an Error with the message to show. */
    async grant(space: string | null, boxId: string): Promise<void> {
      try {
        await grantBox(space, boxId, api);
      } catch (err) {
        throw new Error(apiError(err, `Could not add the box to ${space}`));
      }
    },
  };
}
