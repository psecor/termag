// The context menu on a space's head in the simple UI's sidebar, and on "No
// space"'s (pages/chat/OpenItems.tsx): a right click, Shift+F10 or the menu
// key, or a long press on a touch screen. These are the actions on the
// space's open tabs. A feature with actions on the space itself puts its own
// beside these (spaceMenu's `tabs` section takes them as they are) rather
// than editing them.
import type { MenuAction } from '../pages/chat/ContextMenu';
import type { OpenItem } from './openItems';

/**
 * Close all tabs and Close file tabs for a space whose tabs are `items`, in
 * their order. `close` gets the ids to close; each action is disabled when
 * there is nothing for it to close. Closing only takes tabs off the list.
 */
export function spaceHeaderContextActions(items: readonly OpenItem[], close: (ids: string[]) => void): MenuAction[] {
  const all = items.map(i => i.id);
  const files = items.filter(i => i.kind === 'file').map(i => i.id);
  return [
    { label: 'Close all tabs', disabled: all.length === 0, onSelect: () => close(all) },
    { label: 'Close file tabs', disabled: files.length === 0, onSelect: () => close(files) },
  ];
}
