// The one menu on a space's head in the simple UI's sidebar (and on "No
// space"'s): its ⋮, and the same menu, hung from the ⋮, on a right click,
// Shift+F10 or the menu key, or a long press on the head
// (pages/chat/OpenItems.tsx). The order lives here, in sections, so a feature
// adds its own section rather than editing another's:
//   1. create: New agent, New automation (with simple-ui-automations-enabled), New tab (spaceCreateActions)
//   2. space:  the space's own actions, e.g. Share space…, at index 2
//   3. tabs:   Close all tabs, Close file tabs (spaceHeaderActions.ts)
import type { MenuAction } from '../pages/chat/ContextMenu';

export interface SpaceHeadMenuSections {
  /** What the space starts: New agent, New tab. */
  create?: readonly MenuAction[];
  /** Actions on the space itself (Share space…). Empty for "No space". */
  space?: readonly MenuAction[];
  /** Actions on the space's open tabs. */
  tabs?: readonly MenuAction[];
}

export function spaceHeadMenuActions({ create = [], space = [], tabs = [] }: SpaceHeadMenuSections): MenuAction[] {
  return [...create, ...space, ...tabs];
}

/**
 * New agent and New tab for `space`, or for "No space" (null), where New tab
 * is the explorer of agents in no space (AgentsExplorer.tsx). New agent is
 * disabled where the person can't start agents (a viewer), and says so.
 * `newAutomation`, when given (simple-ui-automations-enabled), adds New
 * automation after New agent: New session on a schedule, in this space, so
 * the automation is listed in it (chat/automationPlaces.ts).
 */
export function spaceCreateActions(
  space: string | null,
  { canStart, newAgent, newTab, newAutomation }: { canStart: boolean; newAgent: () => void; newTab: () => void; newAutomation?: () => void },
): MenuAction[] {
  if (space === null) {
    return [
      { label: 'New agent', hint: 'A session with no space', onSelect: newAgent },
      ...(newAutomation ? [{ label: 'New automation', hint: 'An agent on a schedule, in no space', onSelect: newAutomation }] : []),
      { label: 'New tab', hint: 'Browse your agents in no space', onSelect: newTab },
    ];
  }
  return [
    { label: 'New agent', disabled: !canStart, hint: canStart ? `Starts on its own box, with access to ${space}` : `You can't start agents in ${space}`, onSelect: newAgent },
    ...(newAutomation ? [{ label: 'New automation', disabled: !canStart, hint: canStart ? `An agent on a schedule, in ${space}` : `You can't start agents in ${space}`, onSelect: newAutomation }] : []),
    { label: 'New tab', hint: `Browse ${space}'s agents and files`, onSelect: newTab },
  ];
}
