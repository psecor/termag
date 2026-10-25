// New chat's optional space step (chat/chatSpaces.ts): no space, one of the
// user's spaces they can edit, or a new one. Drawn like the repository
// trigger above it: a compact button, with the choices in a menu, each space
// with its colour (chat/spaceColors.ts) as the sidebar shows it. The chat's
// new box gets editor access to the chosen space before the chat starts.
import React, { useEffect, useId, useRef, useState } from 'react';
import type { SpaceView } from '../../services/api';
import { pickableSpaces, slugifySpaceName, spaceNameOf, spaceTriggerLabel, type SpaceChoice } from '../../chat/chatSpaces';
import { SPACE_NAME_HINT } from '../../utils/spaces';
import { SpaceSwatch } from './SpaceSwatch';

function Caret() {
  return <span className="chat-compose-caret" aria-hidden="true" />;
}

export function SpacePicker({ value, onChange, spaces, error, disabled, menuEpoch = 0, onOpen }: {
  value: SpaceChoice;
  onChange: (next: SpaceChoice) => void;
  spaces: readonly SpaceView[];
  error?: string;
  disabled?: boolean;
  /** Bumps when the page opens another menu or sends, so this one closes. */
  menuEpoch?: number;
  /** The menu is opening, so the page can close the repository and model menus. */
  onOpen?: () => void;
}) {
  const options = pickableSpaces(spaces);
  const label = spaceTriggerLabel(value);
  // A new space shows the colour its name will have as soon as it has one.
  const chosen = value.kind === 'existing' ? value.name : value.kind === 'new' ? spaceNameOf(value.name) || null : null;
  const listId = useId();
  const errorId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  // A new space's name is only wrong once the user has had a go at it.
  const [nameTouched, setNameTouched] = useState(false);
  const shownError = value.kind === 'new' && !nameTouched ? '' : error;
  const seenEpoch = useRef(menuEpoch);

  useEffect(() => {
    if (seenEpoch.current === menuEpoch) return;
    seenEpoch.current = menuEpoch;
    setOpen(false);
  }, [menuEpoch]);

  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);

  useEffect(() => {
    if (!open) return;
    if (value.kind === 'new') inputRef.current?.focus();
    else menuRef.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus();
  }, [open, value.kind]);

  useEffect(() => {
    if (!open) return;
    function onPointer(e: PointerEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    }
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  function toggle() {
    if (disabled) return;
    const next = !open;
    if (next) onOpen?.();
    setOpen(next);
  }

  function onTriggerKeyDown(e: React.KeyboardEvent) {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    if (open || disabled) return;
    onOpen?.();
    setOpen(true);
  }

  function commit(next: SpaceChoice) {
    onChange(next);
    setOpen(false);
    triggerRef.current?.focus();
  }

  function chooseNew() {
    if (value.kind !== 'new') {
      setNameTouched(false);
      onChange({ kind: 'new', name: '' });
      return;
    }
    inputRef.current?.focus();
  }

  function onMenuKeyDown(e: React.KeyboardEvent) {
    if ((e.target as HTMLElement).tagName === 'INPUT') return;
    const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? [])];
    const i = items.findIndex(item => item === document.activeElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      items[Math.min(Math.max(i, 0) + 1, items.length - 1)]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      items[Math.max(i - 1, 0)]?.focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      items[0]?.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      items[items.length - 1]?.focus();
    }
  }

  return (
    <div ref={rootRef} className="chat-compose-repo chat-new-space">
      <button
        ref={triggerRef}
        type="button"
        className="chat-compose-repo-btn"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-label={`Space (optional), ${label}`}
        aria-describedby={shownError ? errorId : undefined}
        aria-invalid={shownError ? true : undefined}
        title="Space (optional)"
        disabled={disabled}
        onClick={toggle}
        onKeyDown={onTriggerKeyDown}
      >
        <SpaceSwatch space={chosen} />
        <span className="chat-compose-repo-name">{label}</span>
        <Caret />
      </button>
      {open && (
        <div ref={menuRef} className="chat-compose-menu" onKeyDown={onMenuKeyDown}>
          <div id={listId} role="listbox" aria-label="Spaces">
            <button type="button" role="option" tabIndex={-1} aria-selected={value.kind === 'none'} className="chat-compose-option chat-space-option" onClick={() => commit({ kind: 'none' })}><SpaceSwatch space={null} />No space</button>
            {options.map(s => (
              <button
                key={s.id}
                type="button"
                role="option"
                tabIndex={-1}
                aria-selected={value.kind === 'existing' && value.name === s.name}
                className="chat-compose-option chat-space-option"
                onClick={() => commit({ kind: 'existing', name: s.name })}
              >
                <SpaceSwatch space={s.name} />
                {s.name}
              </button>
            ))}
            <button type="button" role="option" tabIndex={-1} aria-selected={value.kind === 'new'} className="chat-compose-option chat-space-option chat-space-option-new" onClick={chooseNew}>New space…</button>
          </div>
          {value.kind === 'new' && (
            <label className="chat-compose-paste">
              <span>New space name</span>
              <input
                ref={inputRef}
                aria-label="New space name"
                value={value.name}
                disabled={disabled}
                placeholder="e.g. team-notes"
                title={SPACE_NAME_HINT}
                onBlur={() => setNameTouched(true)}
                onChange={e => { setNameTouched(true); onChange({ kind: 'new', name: slugifySpaceName(e.target.value) }); }}
                // Same as the repository URL paste: Enter must not submit the form and launch a box.
                onKeyDown={e => { if (e.key === 'Enter') e.preventDefault(); }}
              />
            </label>
          )}
          <div className="chat-compose-note">
            A space is a shared file store. This session's box can read and write it, and so can a box it starts.
          </div>
        </div>
      )}
      {shownError && <span className="chat-new-error" id={errorId}>{shownError}</span>}
    </div>
  );
}
