// The sidebar's head and foot under the chrome refresh,
// all LaunchPad: the brand, New session as
// a full-width row with its shortcut, Search, and the account at the foot with
// its menu (Open Lab, Settings) and a Settings button beside it.
import React from 'react';
import { Link, useHref, useNavigate } from 'react-router-dom';
import {
  Button, IconButton, InitialsAvatar, LinkButton, LinkIconButton, Menu, MenuItem, MenuTrigger, Popover, RouterProvider, Text, Tooltip, TooltipTrigger,
} from '@launchpad-ui/components';
import { Icon } from '@launchpad-ui/icons';
import { useAuth } from '../../contexts/AuthContext';
import { useConnection } from '../../contexts/ConnectionContext';
import { LP_THEME } from '../../launchpad/theme';
import { OPEN_PALETTE_EVENT } from '../../utils/searchPalette';
import { currentSearchShortcut } from '../../utils/workspaceTarget';
import { ViewOptions } from './ViewOptions';
import { useWhatsNewDialog, whatsNewLabel } from '../../whatsNew/useWhatsNew';

const SEARCH_KEYS = currentSearchShortcut();
const SETTINGS_HREF = '/settings?from=chat';

/** LaunchPad's links navigate in the app (React Aria's router), with the app's basename on their hrefs. */
function AppRouter({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate();
  return <RouterProvider navigate={navigate} useHref={useHref}>{children}</RouterProvider>;
}

/** Up to two initials for the account's avatar: of the name, else of the email's local part. */
export function accountInitials(name: string): string {
  const words = name.replace(/@.*/, '').split(/[\s._-]+/).filter(Boolean);
  if (words.length === 0) return '?';
  return (words.length > 1 ? words[0][0] + words[1][0] : words[0].slice(0, 2)).toUpperCase();
}

/**
 * The sidebar's top: the brand, then New session and Search. `search` is
 * ChatSearch, kept mounted for ⌘K and its palette; SearchButton stands in for
 * its trigger, which the refresh hides.
 */
export function SidebarTop({ newSessionKeys, search, viewOptions }: { newSessionKeys: string; search: React.ReactNode; viewOptions: boolean }) {
  return (
    <>
      <div className="chat-sidebar-head">
        <Link to="/chat" className="chat-brand">
          <Icon name="terminal" size="medium" className="chat-brand-mark" aria-hidden="true" />
          termag
        </Link>
      </div>
      <div className="chat-sidebar-actions">
        <NewSessionRow keys={newSessionKeys} />
        <div className="chat-search-row">
          <div className="chat-search">
            {search}
            <SearchButton />
          </div>
          {/* The view options are the tabs sidebar's (OpenItems.tsx). */}
          {viewOptions && <ViewOptions />}
        </div>
      </div>
    </>
  );
}

/** New session, a full-width row so it can't be missed, with its shortcut at the end. */
function NewSessionRow({ keys }: { keys: string }) {
  return (
    <AppRouter>
      <LinkButton href="/chat/new" variant="minimal" className="chat-new-row" aria-label="New session" aria-keyshortcuts={keys}>
        <Icon name="edit" size="medium" aria-hidden="true" />
        <span className="chat-new-row-label">New session</span>
        <kbd className="chat-new-kbd" aria-hidden="true">{keys}</kbd>
      </LinkButton>
    </AppRouter>
  );
}

/** Search: opens ChatSearch's palette with the same event its own trigger's click amounts to. */
function SearchButton() {
  const offline = useConnection().state === 'offline';
  return (
    <Button
      variant="minimal"
      className="chat-search-button"
      isDisabled={offline}
      aria-keyshortcuts={SEARCH_KEYS}
      onPress={() => window.dispatchEvent(new CustomEvent(OPEN_PALETTE_EVENT))}
    >
      <Icon name="search" size="medium" aria-hidden="true" />
      <span className="chat-search-button-label">Search</span>
      <kbd className="chat-search-kbd" aria-hidden="true">{SEARCH_KEYS}</kbd>
    </Button>
  );
}

/** The account at the sidebar's foot: a menu with Open Lab and Settings (and What's new), and Settings beside it. */
export function AccountFoot({ openFullUi }: { openFullUi: () => void }) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const name = user?.displayName || user?.email || '';
  const whatsNew = useWhatsNewDialog('termag');
  return (
    <AppRouter>
      <MenuTrigger>
        <Button variant="minimal" className="chat-account" aria-label="Account and Lab">
          <InitialsAvatar size="small" className="chat-account-avatar" aria-hidden="true">{accountInitials(name)}</InitialsAvatar>
          <span className="chat-account-text">
            <span className="chat-account-name">{name}</span>
            {user?.displayName && user.email && <span className="chat-account-sub">{user.email}</span>}
          </span>
          <Icon name="chevron-up" size="medium" className="chat-account-caret" aria-hidden="true" />
        </Button>
        <Popover placement="top start" className={`${LP_THEME} chat-menu-popover`}>
          <Menu onAction={key => { if (key === 'full') openFullUi(); else if (key === 'settings') navigate(SETTINGS_HREF); else if (key === 'whats-new') whatsNew.open(); }}>
            <MenuItem id="full" textValue="Open Lab">
              <Icon name="arrow-up-right" size="medium" aria-hidden="true" />
              <Text slot="label">Open Lab</Text>
              <Text slot="description">termag opens in the UI you used last</Text>
            </MenuItem>
            <MenuItem id="settings" textValue="Settings">
              <Icon name="gear-outline" size="medium" aria-hidden="true" />
              <Text slot="label">Settings</Text>
            </MenuItem>
            {whatsNew.enabled && (
              <MenuItem id="whats-new" textValue="What's new">
                <Icon name="sparkles" size="medium" aria-hidden="true" />
                <Text slot="label">What's new</Text>
              </MenuItem>
            )}
          </Menu>
        </Popover>
      </MenuTrigger>
      {/* What's new beside Settings, its dot on top while there are unseen entries. */}
      {whatsNew.enabled && (
        <span className="whats-new-trigger">
          <TooltipTrigger delay={300}>
            <IconButton icon="sparkles" aria-label={whatsNewLabel(whatsNew.unseen)} variant="minimal" className="chat-settings-button" onPress={whatsNew.open} />
            <Tooltip placement="top" className={LP_THEME}>What's new</Tooltip>
          </TooltipTrigger>
          {whatsNew.unseen > 0 && <span className="whats-new-trigger-dot" aria-hidden="true" />}
        </span>
      )}
      {whatsNew.dialog}
      <TooltipTrigger delay={300}>
        <LinkIconButton href={SETTINGS_HREF} icon="gear-outline" aria-label="Settings" variant="minimal" className="chat-settings-button" />
        <Tooltip placement="top" className={LP_THEME}>Settings</Tooltip>
      </TooltipTrigger>
    </AppRouter>
  );
}
