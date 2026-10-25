// The model control in the simple UI's composers: New chat's bar, and an
// open session's, where a change applies from the next message on. Claude's
// tiers, then the viewer's Fireworks models under their own heading.
import React, { useEffect, useRef } from 'react';
import { chatModelLabel, chatModelOptions, type ChatModelId, type ChatModelOption } from './composer';

const CLAUDE_ONLY = chatModelOptions([]);

export function ModelPicker({ model, options = CLAUDE_ONLY, onChange, open, onOpenChange, disabled }: {
  model: ChatModelId | null;
  options?: ChatModelOption[];
  onChange: (id: ChatModelId) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  disabled?: boolean;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    function onPointer(e: PointerEvent) {
      if (!rootRef.current?.contains(e.target as Node)) onOpenChange(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onOpenChange(false);
    }
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onOpenChange]);

  return (
    <div className="chat-compose-model" ref={rootRef}>
      <button
        type="button"
        className="chat-compose-model-btn"
        aria-expanded={open}
        aria-haspopup="listbox"
        disabled={disabled}
        onClick={() => { if (!disabled) onOpenChange(!open); }}
      >
        <span>{model ? chatModelLabel(model, options) : '…'}</span>
        <span className="chat-compose-caret" aria-hidden="true" />
      </button>
      {open && (
        <div className="chat-compose-model-menu" role="listbox" aria-label="Model">
          {options.map((item, i) => (
            <React.Fragment key={item.id}>
            {item.fireworks && !options[i - 1]?.fireworks && <div className="chat-compose-option-group" role="presentation">Fireworks</div>}
            <button
              type="button"
              role="option"
              aria-selected={model != null && item.id === model}
              className="chat-compose-option"
              onClick={() => { onChange(item.id); onOpenChange(false); }}
            >
              {item.label}
            </button>
            </React.Fragment>
          ))}
        </div>
      )}
    </div>
  );
}
