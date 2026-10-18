import React from 'react';
import { Dialog } from './Dialog';

export type ConfirmTone = 'danger' | 'primary';

/** `danger` (red) is for what can't be undone: archive, terminate, delete, revoke.
 *  `primary` is for confirmations the user can reverse, like stopping a box. */
export function ConfirmDialog({ message, onConfirm, onCancel, confirmLabel = 'Confirm', tone = 'danger' }: {
  message: React.ReactNode;
  onConfirm: () => void;
  onCancel: () => void;
  confirmLabel?: string;
  tone?: ConfirmTone;
}) {
  return (
    <Dialog ariaLabel={confirmLabel} onClose={onCancel}>
      <div className="confirm-message">{message}</div>
      <div className="confirm-actions">
        <button className="confirm-btn confirm-btn-cancel" onClick={onCancel}>Cancel</button>
        <button
          className={`confirm-btn ${tone === 'primary' ? 'confirm-btn-primary' : 'confirm-btn-confirm'}`}
          onClick={onConfirm}
          autoFocus
        >{confirmLabel}</button>
      </div>
    </Dialog>
  );
}
