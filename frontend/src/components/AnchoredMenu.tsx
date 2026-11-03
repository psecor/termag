// A ⋮ menu of the full UI's sidebar (project, workstream, cloud session and box
// rows in ProjectControl), drawn in a portal next to the ⋮ that opened it. The
// positioning is LaunchPad's Popover (React Aria's): it flips above the
// trigger and shifts sideways to stay inside the viewport, so a menu is no
// longer clipped by the sidebar's edge or by a scrolling list (`.boxes-expanded`
// is a 40vh scroll area). The items keep the full UI's `.project-menu` look.
import React, { useCallback, useMemo, useState } from 'react';
import { Popover } from '@launchpad-ui/components';

export function AnchoredMenu({ anchor, onClose, children }: {
  /** The ⋮ button the menu belongs to; null draws nothing. */
  anchor: HTMLElement | null;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const triggerRef = useMemo(() => ({ current: anchor }), [anchor]);
  if (!anchor) return null;
  return (
    <Popover
      triggerRef={triggerRef}
      isOpen
      onOpenChange={open => { if (!open) onClose(); }}
      placement="bottom end"
      offset={2}
      containerPadding={8}
      className="anchored-menu-popover"
    >
      {/* Clicks in the menu must not reach the row under it (rows open their project). */}
      <div className="project-menu anchored-menu" onClick={e => e.stopPropagation()} onMouseLeave={onClose}>
        {children}
      </div>
    </Popover>
  );
}

/**
 * The one ⋮ that owns the open menu, across every kind of row. Each kind keeps
 * its own open id (ProjectControl's menuOpenId, cloudMenuKey, boxMenuOpenId),
 * which nothing clears when another kind's ⋮ is pressed, so a menu shows only
 * while its own key holds the anchor: a stale id can't put a project's menu
 * over the box row just opened (Bugbot on #877).
 */
export function useMenuAnchor(): {
  /** A ⋮ was pressed: it owns the menu now (its own open id says whether it is open). */
  claim: (key: string, el: HTMLElement) => void;
  /** The ⋮ to anchor this key's menu to, or null when another key (or none) owns it. */
  anchorFor: (key: string) => HTMLElement | null;
} {
  const [owner, setOwner] = useState<{ key: string; el: HTMLElement } | null>(null);
  const claim = useCallback((key: string, el: HTMLElement) => setOwner({ key, el }), []);
  const anchorFor = useCallback((key: string) => (owner?.key === key ? owner.el : null), [owner]);
  return { claim, anchorFor };
}
