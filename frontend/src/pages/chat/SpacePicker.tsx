// New session's optional space (chat/chatSpaces.ts): no space, one of the
// user's spaces they can edit, or a new one. In the drawer it is a trigger
// like the box's (pages/chat/LaunchDrawer.tsx): the space's colour
// (chat/spaceColors.ts) and name, no caret, opening a dialog of choices drawn
// as the box dialog's cards. Picking No space or a space closes it; New space
// opens its name field inside the card and waits for Done. The session's box
// gets editor access to the chosen space before the chat starts.
import React, { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { SpaceView } from '../../services/api';
import { pickableSpaces, slugifySpaceName, spaceNameOf, spaceTriggerLabel, type SpaceChoice } from '../../chat/chatSpaces';
import { SPACE_NAME_HINT } from '../../utils/spaces';
import { Dialog } from '../../components/Dialog';
import { Tooltip } from '../../components/Tooltip';
import { SpaceSwatch } from './SpaceSwatch';

export function SpacePicker({ value, onChange, spaces, error, disabled, menuEpoch = 0, onOpen }: {
  value: SpaceChoice;
  onChange: (next: SpaceChoice) => void;
  spaces: readonly SpaceView[];
  error?: string;
  disabled?: boolean;
  /** Bumps when the page opens a menu or sends, so the dialog closes. */
  menuEpoch?: number;
  /** The dialog is opening, so the page can close the repository and model menus. */
  onOpen?: () => void;
}) {
  const options = pickableSpaces(spaces);
  const label = spaceTriggerLabel(value);
  // A new space shows the colour its name will have as soon as it has one.
  const chosen = value.kind === 'existing' ? value.name : value.kind === 'new' ? spaceNameOf(value.name) || null : null;
  const errorId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
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
    if (open && value.kind === 'new') inputRef.current?.focus();
  }, [open, value.kind]);

  function show() {
    if (disabled) return;
    onOpen?.();
    setOpen(true);
  }

  function close() {
    setOpen(false);
    triggerRef.current?.focus();
  }

  function commit(next: SpaceChoice) {
    onChange(next);
    close();
  }

  function chooseNew() {
    if (value.kind !== 'new') {
      setNameTouched(false);
      onChange({ kind: 'new', name: '' });
      return;
    }
    inputRef.current?.focus();
  }

  return (
    <div className="chat-new-space">
      <Tooltip content={<><strong>Space (optional)</strong><span className="ui-tooltip-sub">A shared file store this session's box can read and write</span></>}>
      <button
        ref={triggerRef}
        type="button"
        className="chat-launch-trigger chat-space-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Space (optional), ${label}`}
        aria-describedby={shownError ? errorId : undefined}
        aria-invalid={shownError ? true : undefined}
        disabled={disabled}
        onClick={show}
      >
        <SpaceSwatch space={chosen} />
        <span className="chat-launch-trigger-label">{label}</span>
      </button>
      </Tooltip>
      {shownError && !open && <span className="chat-new-error" id={errorId}>{shownError}</span>}
      {open && createPortal(
        <Dialog title="Space" onClose={close} className="chat-launch-dialog chat-space-dialog">
          <p className="chat-launch-dialog-note">
            A space is a shared file store. This session's box can read and write it, and so can a box it starts.
          </p>
          <div className="chat-launch-boxes" role="radiogroup" aria-label="Spaces">
            <button
              type="button"
              role="radio"
              aria-checked={value.kind === 'none'}
              className="chat-launch-box chat-space-choice"
              onClick={() => commit({ kind: 'none' })}
            >
              <span className="chat-launch-box-name"><SpaceSwatch space={null} />No space</span>
            </button>
            {options.length > 0 && <div className="chat-menu-heading">Your spaces</div>}
            {options.map(s => (
              <button
                key={s.id}
                type="button"
                role="radio"
                aria-checked={value.kind === 'existing' && value.name === s.name}
                className="chat-launch-box chat-space-choice"
                onClick={() => commit({ kind: 'existing', name: s.name })}
              >
                <span className="chat-launch-box-name"><SpaceSwatch space={s.name} />{s.name}</span>
                {s.description && <small>{s.description}</small>}
              </button>
            ))}
            {/* New space and its name are one choice: the name field opens inside it once picked. */}
            <div className="chat-launch-new" data-checked={value.kind === 'new' || undefined}>
              <button
                type="button"
                role="radio"
                aria-checked={value.kind === 'new'}
                className="chat-launch-box chat-space-choice"
                onClick={chooseNew}
              >
                <span className="chat-launch-box-name"><span className="chat-space-plus" aria-hidden="true">+</span>New space</span>
                <small>Made when the session starts</small>
              </button>
              {value.kind === 'new' && (
                <div className="chat-launch-new-name">
                  <label className="chat-new-field chat-launch-new-field">
                    <span>Name</span>
                    <input
                      ref={inputRef}
                      aria-label="New space name"
                      value={value.name}
                      disabled={disabled}
                      placeholder="e.g. team-notes"
                      title={SPACE_NAME_HINT}
                      aria-describedby={shownError ? errorId : undefined}
                      aria-invalid={shownError ? true : undefined}
                      onBlur={() => setNameTouched(true)}
                      onChange={e => { setNameTouched(true); onChange({ kind: 'new', name: slugifySpaceName(e.target.value) }); }}
                      // Enter is Done, as in a form; it never starts the session.
                      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); close(); } }}
                    />
                    {shownError && <span className="chat-new-error" id={errorId}>{shownError}</span>}
                  </label>
                </div>
              )}
            </div>
          </div>
          <div className="chat-launch-dialog-actions">
            <button type="button" className="btn-primary" onClick={close}>Done</button>
          </div>
        </Dialog>,
        document.body,
      )}
    </div>
  );
}
