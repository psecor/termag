// A space's colour mark (chat/spaceColors.ts): a filled rounded square, so it
// is not mistaken for a status glyph's circle. No space is a hollow dashed
// square in the theme's secondary text colour. Decorative: the space's name
// is always beside it.
import React from 'react';
import { spaceOfBox } from '../../chat/chatSpaces';
import { spaceColorStyle } from '../../chat/spaceColors';
import { useSharedChatSpaces } from '../../chat/useChatSpaces';

export function SpaceSwatch({ space }: { space: string | null }) {
  const style = spaceColorStyle(space, useSharedChatSpaces().colorOf);
  return <span className="space-swatch" data-space={style ? undefined : 'none'} style={style} aria-hidden="true" />;
}

/**
 * The chat header's space: the box's space as the sidebar groups it, or "No
 * space" once the user has spaces at all. Nothing while spaces are off or
 * still loading, including the reload after a new box appears.
 */
export function ChatSpaceChip({ instanceId }: { instanceId: string | null | undefined }) {
  const { enabled, loaded, current, spaces, index, colorOf } = useSharedChatSpaces();
  if (!enabled || !loaded) return null;
  const at = spaceOfBox(instanceId, index);
  // A box the index doesn't know yet (a new session, its reload in flight) is not "No space".
  if (!at && (!current || spaces.length === 0)) return null;
  const name = at?.space ?? 'No space';
  const title = at
    ? `In space ${at.space}${at.alsoIn.length > 0 ? `, also in ${at.alsoIn.join(', ')}` : ''}`
    : 'This session\'s box is in no space';
  return (
    <span className="chat-title-space" data-space={at ? undefined : 'none'} style={spaceColorStyle(at?.space, colorOf)} title={title}>
      <SpaceSwatch space={at?.space ?? null} />
      <span className="chat-title-space-name">{name}</span>
    </span>
  );
}
