// The What's new links that sit among text links: termag's sidebar foot
// without the chrome refresh, and lab's sidebar head beside How it works.
// The refresh's foot has an icon button and a menu item instead (AccountFoot
// in pages/chat/SidebarChrome.tsx). Each renders nothing while
// whats-new-enabled is off.
import React from 'react';
import { Button } from '@launchpad-ui/components';
import { LP_THEME } from '../launchpad/theme';
import { useWhatsNewDialog, whatsNewLabel } from './useWhatsNew';

/** termag's sidebar foot, beside Lab and Settings: a LaunchPad button drawn as the foot's links are. */
export function WhatsNewFootLink() {
  const { enabled, unseen, open, dialog } = useWhatsNewDialog('termag');
  if (!enabled) return null;
  return (
    <>
      <Button variant="minimal" size="small" className={`${LP_THEME} chat-foot-link whats-new-foot-link`} aria-label={whatsNewLabel(unseen)} onPress={open}>
        What's new{unseen > 0 && <span className="whats-new-link-dot" aria-hidden="true" />}
      </Button>
      {dialog}
    </>
  );
}

/** lab's sidebar head, beside How it works ↗. The lab needs no LaunchPad, so a plain button in the link's style. */
export function WhatsNewLabLink() {
  const { enabled, unseen, open, dialog } = useWhatsNewDialog('lab');
  if (!enabled) return null;
  return (
    <>
      <button type="button" className="sidebar-docs-link whats-new-lab-link" aria-label={whatsNewLabel(unseen)} onClick={open}>
        What's new{unseen > 0 && <span className="whats-new-link-dot" aria-hidden="true" />}
      </button>
      {dialog}
    </>
  );
}
