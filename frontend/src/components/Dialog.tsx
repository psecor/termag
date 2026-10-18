import React, { useEffect, useId, useRef } from 'react';

/**
 * The one modal shell: the confirm-backdrop scrim and the confirm-dialog
 * panel (className sets the width), role="dialog" labelled by its title,
 * Escape and a press on the backdrop close it, and focus moves into the panel
 * when nothing inside took it with autoFocus.
 *
 * onKeyDown runs first; a handler that calls preventDefault on Escape keeps
 * the dialog open (the PR overlay blurs a field instead). Escape stops here,
 * so a dialog opened over another closes alone.
 */
export function Dialog({
  title, ariaLabel, labelledBy, onClose, closeDisabled, className, backdropClassName, onKeyDown, panelRef, children,
}: {
  title?: React.ReactNode;
  /** For a dialog with no visible title. */
  ariaLabel?: string;
  /** For a dialog whose title is rendered by its children. */
  labelledBy?: string;
  onClose: () => void;
  /** While a save is in flight: Escape and the backdrop do nothing. */
  closeDisabled?: boolean;
  className?: string;
  /** Placement or layer: confirm-backdrop--top (a palette), confirm-backdrop--under (the PR overlay). */
  backdropClassName?: string;
  onKeyDown?: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  panelRef?: React.MutableRefObject<HTMLDivElement | null>;
  children: React.ReactNode;
}) {
  const titleId = useId();
  const own = useRef<HTMLDivElement | null>(null);
  // A drag that starts in the panel and ends on the backdrop (selecting text) is not a close.
  const pressedBackdrop = useRef(false);

  useEffect(() => {
    const el = own.current;
    if (el && !el.contains(document.activeElement)) el.focus();
  }, []);

  const setRef = (el: HTMLDivElement | null) => {
    own.current = el;
    if (panelRef) panelRef.current = el;
  };

  return (
    <div
      className={`confirm-backdrop${backdropClassName ? ` ${backdropClassName}` : ''}`}
      onMouseDown={e => { pressedBackdrop.current = e.target === e.currentTarget; }}
      onClick={e => {
        const close = pressedBackdrop.current && e.target === e.currentTarget;
        pressedBackdrop.current = false;
        if (close && !closeDisabled) onClose();
      }}
    >
      <div
        ref={setRef}
        // Dialogs render inside clickable rows (ProjectControl); a click in one must not reach the row.
        onClick={e => e.stopPropagation()}
        className={`confirm-dialog${className ? ` ${className}` : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        aria-labelledby={title ? titleId : labelledBy}
        tabIndex={-1}
        onKeyDown={e => {
          onKeyDown?.(e);
          if (e.key !== 'Escape') return;
          e.stopPropagation();
          if (e.defaultPrevented) return;
          e.preventDefault();
          if (!closeDisabled) onClose();
        }}
      >
        {title && <div className="dialog-title" id={titleId}>{title}</div>}
        {children}
      </div>
    </div>
  );
}
