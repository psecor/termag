import React from 'react';

export function ConfirmDialog({ message, onConfirm, onCancel }: {
  message: React.ReactNode;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="confirm-backdrop" onClick={onCancel}>
      <div className="confirm-dialog" onClick={e => e.stopPropagation()}>
        <div className="confirm-message">{message}</div>
        <div className="confirm-actions">
          <button className="confirm-btn confirm-btn-cancel" onClick={onCancel}>Cancel</button>
          <button className="confirm-btn confirm-btn-confirm" onClick={onConfirm} autoFocus>Confirm</button>
        </div>
      </div>
    </div>
  );
}
