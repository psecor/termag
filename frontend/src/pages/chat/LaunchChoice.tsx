// One choice in a New session drawer dialog drawn as a list of rows: the space
// dialog (SpacePicker.tsx), the environment dialog (EnvironmentSelect.tsx) and
// the box dialog's New box (LaunchDrawer.tsx).
// A radio card as the box dialog's are (LaunchDrawer.tsx), with an optional
// line under the name and an optional mark before it. The space dialog marks
// each row (a space's colour, the dashed square of "none", a "+" for a new one);
// the box dialog marks only New box, with LaunchPad's sparkle (LaunchDrawer.tsx);
// the environment dialog marks none, since an environment has no colour.
// The selection is the card's checked style (aria-checked), never the mark.
// The cards are termag's, not LaunchPad's: the drawer's dialogs are all drawn
// this way, and LaunchPad's RadioGroup has no card with a line under its label.
import React from 'react';

/** A "none" or a "+ New …" choice's mark; a space or an environment brings its own. */
export function LaunchChoiceMark({ kind }: { kind: 'none' | 'new' }) {
  return kind === 'none'
    ? <span className="space-swatch" data-space="none" aria-hidden="true" />
    : <span className="chat-space-plus" aria-hidden="true">+</span>;
}

/**
 * `checked` undefined: an action drawn as a choice (a "+ New …" that opens a page), a plain button, not a radio.
 * Any other props and the ref go to the button, so a LaunchPad Focusable can hang a Tooltip on it (New box's).
 * `type` and `className` stay the choice's own, and are refused here, so a caller's is not silently dropped.
 */
export function LaunchChoice({ checked, mark, name, line, onClick, disabled, ref, ...rest }: Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'name' | 'onClick' | 'type' | 'className'> & {
  ref?: React.Ref<HTMLButtonElement>;
  checked?: boolean;
  /** Before the name; none for a row with nothing to show there. */
  mark?: React.ReactNode;
  name: React.ReactNode;
  /** Under the name, indented past the mark when there is one. */
  line?: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      {...rest}
      ref={ref}
      type="button"
      role={checked === undefined ? undefined : 'radio'}
      aria-checked={checked}
      className={`chat-launch-box chat-space-choice${mark ? ' chat-launch-choice-marked' : ''}`}
      disabled={disabled}
      onClick={onClick}
    >
      <span className="chat-launch-box-name">{mark}{name}</span>
      {line && <small>{line}</small>}
    </button>
  );
}
