// Bottom sheet for the phone client: a menu of actions, a small form, or a
// confirmation. One component so every sheet dismisses the same way (tap the
// backdrop, Escape, or a Cancel button).
import React, { useEffect } from 'react';

export function Sheet({ title, onClose, children }: { title?: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="m-sheet-backdrop" onClick={onClose}>
      <div className="m-sheet" role="dialog" aria-modal="true" aria-label={title} onClick={e => e.stopPropagation()}>
        {title && <div className="m-sheet-title">{title}</div>}
        {children}
      </div>
    </div>
  );
}

export interface SheetAction {
  label: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
}

export function ActionSheet({ title, actions, onClose }: { title?: string; actions: SheetAction[]; onClose: () => void }) {
  return (
    <Sheet title={title} onClose={onClose}>
      <div className="m-sheet-actions">
        {actions.map(a => (
          <button
            key={a.label}
            className={`m-sheet-action ${a.danger ? 'danger' : ''}`}
            disabled={a.disabled}
            onClick={() => { onClose(); a.onClick(); }}
          >{a.label}</button>
        ))}
        <button className="m-sheet-action m-sheet-cancel" onClick={onClose}>Cancel</button>
      </div>
    </Sheet>
  );
}

export function ConfirmSheet({ message, confirmLabel = 'Confirm', danger, onConfirm, onClose }: {
  message: React.ReactNode; confirmLabel?: string; danger?: boolean; onConfirm: () => void; onClose: () => void;
}) {
  return (
    <Sheet onClose={onClose}>
      <div className="m-sheet-message">{message}</div>
      <div className="m-sheet-actions">
        <button className={`m-sheet-action ${danger ? 'danger' : ''}`} onClick={() => { onClose(); onConfirm(); }}>{confirmLabel}</button>
        <button className="m-sheet-action m-sheet-cancel" onClick={onClose}>Cancel</button>
      </div>
    </Sheet>
  );
}

/** The server's error message when it sent one, else the fallback. */
export function apiError(err: unknown, fallback: string): string {
  const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
  return typeof msg === 'string' ? msg : fallback;
}
