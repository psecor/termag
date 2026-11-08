// A space's colour mark (chat/spaceColors.ts): a filled rounded square, so it
// is not mistaken for a status glyph's circle. No space is a hollow dashed
// square in the theme's secondary text colour. Decorative: the space's name
// is always beside it.
import React from 'react';
import { chatHeaderSpace, type ChatPlace } from '../../chat/chatSpaces';
import { spaceColorStyle } from '../../chat/spaceColors';
import { useSharedChatSpaces } from '../../chat/useChatSpaces';

export function SpaceSwatch({ space }: { space: string | null }) {
  const style = spaceColorStyle(space, useSharedChatSpaces().colorOf);
  return <span className="space-swatch" data-space={style ? undefined : 'none'} style={style} aria-hidden="true" />;
}

/**
 * The chat header's space: the chat's own (chat/chatSpaces.ts chatHomeSpace),
 * as the sidebar groups it and as its memory loads, or "No space" once the
 * user has spaces at all. Nothing while they are still loading,
 * including the reload after a new box appears.
 */
export function ChatSpaceChip({ place }: { place: ChatPlace }) {
  const { loaded, current, spaces, index, colorOf } = useSharedChatSpaces();
  if (!loaded) return null;
  const at = chatHeaderSpace(place, spaces, index);
  // A chat not fixed yet whose box the index doesn't know (a new session, its reload in flight) is not "No space".
  if (!at && ((!place.spaceFixed && !current) || spaces.length === 0)) return null;
  const name = at?.space ?? 'No space';
  const title = at
    ? `In space ${at.space}${at.alsoIn.length > 0 ? ` (its box also reaches ${at.alsoIn.join(', ')})` : ''}`
    : 'This session is in no space';
  return (
    <span className="chat-title-space" data-space={at ? undefined : 'none'} style={spaceColorStyle(at?.space, colorOf)} title={title}>
      <SpaceSwatch space={at?.space ?? null} />
      <span className="chat-title-space-name">{name}</span>
    </span>
  );
}
