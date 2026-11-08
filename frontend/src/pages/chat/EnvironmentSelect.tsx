// New session's environment, in the drawer beside the
// box and the space, drawn and used as the space is (SpacePicker.tsx): a
// trigger with the environment's name opening a dialog of choices, the rows
// shared with it (LaunchChoice.tsx). Unlike a space, an environment has no
// colour, so no row here has a mark before its name, and the selection shows
// as the card's checked style only. "No environment" leaves the repository
// picker as it was; an environment names the repositories instead. It is
// offered whether or not any environment exists: "New environment" opens
// the Environments page's form, and "Manage environments" the list.
// Picking No environment or an environment closes the dialog.
//
// Every environment is listed (GET /api/environments returns them all, each a
// name and a short definition), in a box with a max height and its own scroll
// (App.css's shared .scroll-list), so the dialog keeps its size however many
// there are. No environment above the box and New environment below it are
// always in view. The search (LaunchPad's SearchField, focused on open) filters
// by name or repository; the selected environment is pinned under "Selected"
// above the box while the search filters it out (utils/environments.ts
// environmentMatches), and scrolled into view in the box when the dialog opens.
// Arrow keys move between the search and the rows; a printable key anywhere
// else in the dialog types into the search.
import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { Button, Group, IconButton, Input, SearchField } from '@launchpad-ui/components';
import { Icon } from '@launchpad-ui/icons';
import type { EnvironmentView } from '../../services/api';
import { environmentLine, environmentMatches, visibilityGroups } from '../../utils/environments';
import { ensureLaunchPadSprite } from '../../launchpad/sprite';
import { LP_THEME } from '../../launchpad/theme';
import { Dialog } from '../../components/Dialog';
import { Tooltip } from '../../components/Tooltip';
import { LaunchChoice } from './LaunchChoice';

export const NEW_ENVIRONMENT_HREF = '/chat/environments/new';
export const ENVIRONMENTS_HREF = '/chat/environments';

/** Stacked layers, drawn as the drawer's box icon is (LaunchDrawer.tsx) so the triggers match. */
function EnvironmentIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 2 14 5 8 8 2 5z M2 8l6 3 6-3 M2 11l6 3 6-3" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

export function EnvironmentSelect({ environments, value, onChange, disabled, menuEpoch = 0, onOpen }: {
  environments: readonly EnvironmentView[];
  value: string | null;
  onChange: (name: string | null) => void;
  disabled?: boolean;
  /** Bumps when the page opens a menu or sends, so the dialog closes. */
  menuEpoch?: number;
  /** The dialog is opening, so the page can close its other menus. */
  onOpen?: () => void;
}) {
  const navigate = useNavigate();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const seenEpoch = useRef(menuEpoch);
  const label = value ?? 'No environment';

  useEffect(() => {
    if (seenEpoch.current === menuEpoch) return;
    seenEpoch.current = menuEpoch;
    setOpen(false);
  }, [menuEpoch]);

  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);

  function show() {
    if (disabled) return;
    onOpen?.();
    setOpen(true);
  }

  function close() {
    setOpen(false);
    triggerRef.current?.focus();
  }

  function commit(name: string | null) {
    onChange(name);
    close();
  }

  function go(href: string) {
    setOpen(false);
    navigate(href);
  }

  return (
    <div className="chat-new-env">
      <Tooltip content={<><strong>Environment (optional)</strong><span className="ui-tooltip-sub">The repositories this session clones and the box they need</span></>}>
      <button
        ref={triggerRef}
        type="button"
        className="chat-launch-trigger chat-env-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Environment (optional), ${label}`}
        disabled={disabled}
        onClick={show}
      >
        <EnvironmentIcon />
        <span className="chat-launch-trigger-label">{label}</span>
      </button>
      </Tooltip>
      {open && createPortal(
        <EnvironmentDialog
          environments={environments}
          value={value}
          onPick={commit}
          onGo={go}
          onClose={close}
        />,
        document.body,
      )}
    </div>
  );
}

/** A printable key with no modifier, except Space, which presses the focused button: what typing outside the search sends to it. */
function isTypedKey(e: React.KeyboardEvent): boolean {
  return e.key.length === 1 && e.key !== ' ' && !e.ctrlKey && !e.metaKey && !e.altKey;
}

/** The dialog itself: mounted on each open, so the search starts empty. */
function EnvironmentDialog({ environments, value, onPick, onGo, onClose }: {
  environments: readonly EnvironmentView[];
  value: string | null;
  onPick: (name: string | null) => void;
  onGo: (href: string) => void;
  onClose: () => void;
}) {
  useEffect(() => { void ensureLaunchPadSprite(); }, []);
  const [query, setQuery] = useState('');
  const groupRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const shown = environmentMatches(environments, { query, selected: value });

  useEffect(() => {
    // After Dialog's own effect, which focuses its panel: typing goes to the search from the start.
    searchRef.current?.focus();
    // The selected environment, wherever it is in the box, is scrolled into view, as little as it takes.
    // (Optional call: jsdom, which the tests run in, has no scrollIntoView.)
    scrollRef.current?.querySelector('[aria-checked="true"]')?.scrollIntoView?.({ block: 'nearest' });
  }, []);

  /** Every row in order: No environment, the pinned one, the box's, New environment. */
  const rowButtons = () => [...(groupRef.current?.querySelectorAll<HTMLButtonElement>('.chat-launch-box:not(:disabled)') ?? [])];

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const target = e.target as HTMLElement;
    if (target === searchRef.current) {
      if (e.key === 'ArrowDown') { e.preventDefault(); rowButtons()[0]?.focus(); }
      return;
    }
    // Anywhere else in the dialog (a row, Manage environments, Done), a printable key types into the search.
    if (isTypedKey(e)) { e.preventDefault(); setQuery(query + e.key); searchRef.current?.focus(); return; }
    const rows = rowButtons();
    const at = rows.indexOf(target as HTMLButtonElement);
    if (at < 0) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); rows[Math.min(at + 1, rows.length - 1)].focus(); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); (at === 0 ? searchRef.current : rows[at - 1])?.focus(); }
  }

  return (
    <Dialog title="Environment" onClose={onClose} className="chat-launch-dialog chat-env-dialog" onKeyDown={onKeyDown}>
      <p className="chat-launch-dialog-note">
        An environment names the repositories a session clones and the box they need, shared with everyone on termag.
        With none, the session uses the repository you pick.
      </p>
      <SearchField aria-label="Search environments" value={query} onChange={setQuery} className={`${LP_THEME} chat-env-search`}>
        <Group className="chat-env-search-group">
          <Icon name="search" size="medium" className="chat-env-search-icon" aria-hidden="true" />
          <Input ref={searchRef} placeholder="Search by name or repository" />
          <IconButton icon="cancel" size="small" variant="minimal" aria-label="Clear the search" className="chat-env-search-clear" />
        </Group>
      </SearchField>
      <div className="chat-env-choices" role="radiogroup" aria-label="Environments" ref={groupRef}>
        <LaunchChoice
          checked={value === null}
          name="No environment"
          onClick={() => onPick(null)}
        />
        {shown.pinned && (
          <div className="chat-env-pinned">
            <div className="chat-menu-heading">Selected</div>
            <EnvironmentRow env={shown.pinned} checked onPick={onPick} />
          </div>
        )}
        {environments.length > 0 && (
          <>
            <div className="scroll-list chat-env-list" ref={scrollRef}>
              {/* Personal first, then shared (utils/environments.ts visibilityGroups). */}
              {visibilityGroups(shown.rows).map(g => (
                <React.Fragment key={g.visibility}>
                  <div className="chat-menu-heading">{g.label}</div>
                  {g.items.map(e => <EnvironmentRow key={e.id} env={e} checked={value === e.name} onPick={onPick} />)}
                </React.Fragment>
              ))}
              {shown.rows.length === 0 && <p className="chat-env-empty">No environment matches “{query.trim()}”</p>}
            </div>
          </>
        )}
        <LaunchChoice
          name="New environment"
          line="Opens the Environments page to make one"
          onClick={() => onGo(NEW_ENVIRONMENT_HREF)}
        />
      </div>
      <div className="chat-launch-dialog-actions chat-env-dialog-actions">
        <Button variant="minimal" size="small" className={LP_THEME} onPress={() => onGo(ENVIRONMENTS_HREF)}>
          Manage environments
        </Button>
        <button type="button" className="btn-primary" onClick={onClose}>Done</button>
      </div>
    </Dialog>
  );
}

function EnvironmentRow({ env, checked, onPick }: { env: EnvironmentView; checked: boolean; onPick: (name: string) => void }) {
  return (
    <LaunchChoice
      checked={checked}
      name={env.name}
      line={environmentLine(env)}
      onClick={() => onPick(env.name)}
    />
  );
}
