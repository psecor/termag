// The model control in the simple UI's composers: New chat's bar, and an
// open session's, where a change applies from the next message on. Claude's
// tiers, then the viewer's Fireworks models under their own heading, and,
// where the chat takes one, an Effort slider
// (chat/EffortSlider.tsx): one pill, "Opus 5.5 · High", for both.
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { chatEffortLabel, chatModelLabel, chatModelOptions, chatModelTakesEffort, type ChatEffortId, type ChatModelId, type ChatModelOption } from './composer';
import { EffortSlider } from './EffortSlider';

const CLAUDE_ONLY = chatModelOptions([]);

function Check() {
  return (
    <svg className="chat-compose-option-check" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M13 4.5 6.5 11 3 7.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** The pill's words: the model, and the effort unless it is Default (or not offered). */
export function modelPickerLabel(model: ChatModelId | null, options: ChatModelOption[], effort: ChatEffortId | null): string {
  if (!model) return '…';
  const name = chatModelLabel(model, options);
  return effort && effort !== 'default' && chatModelTakesEffort(model) ? `${name} · ${chatEffortLabel(effort)}` : name;
}

/** Room above and below the pill, in px, less the menu's gap and a margin from the window's edge. */
export interface MenuRoom { above: number; below: number }

/**
 * Where the menu opens: above the pill, as before, wherever it fits there;
 * else on the side with more room. Its height is capped to that side's room,
 * and the menu scrolls inside it, so it never runs off the window (New
 * session's composer sits mid-page, with a menu taller than the room above).
 */
export function modelMenuPlacement(room: MenuRoom, menuHeight: number): { below: boolean; maxHeight: number } {
  const below = menuHeight > room.above && room.below > room.above;
  return { below, maxHeight: Math.max(0, Math.floor(below ? room.below : room.above)) };
}

const MENU_GAP = 6 + 8;

export function ModelPicker({ model, options = CLAUDE_ONLY, onChange, open, onOpenChange, disabled, effort = null, onEffortChange }: {
  model: ChatModelId | null;
  options?: ChatModelOption[];
  onChange: (id: ChatModelId) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  disabled?: boolean;
  /** The effort, where the chat takes one; null hides the Effort section. */
  effort?: ChatEffortId | null;
  onEffortChange?: (id: ChatEffortId) => void;
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

  // Fireworks' models run at their own effort, so the section goes with them.
  const showEffort = effort != null && onEffortChange != null && chatModelTakesEffort(model);

  const menuRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<{ below: boolean; maxHeight: number } | null>(null);
  useLayoutEffect(() => {
    const pill = rootRef.current?.getBoundingClientRect();
    const menu = menuRef.current;
    if (!open || !pill || !menu) { setPlacement(null); return; }
    setPlacement(modelMenuPlacement({ above: pill.top - MENU_GAP, below: window.innerHeight - pill.bottom - MENU_GAP }, menu.scrollHeight));
  }, [open, showEffort, options.length]);

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
        <span>{modelPickerLabel(model, options, showEffort ? effort : null)}</span>
        <span className="chat-compose-caret" aria-hidden="true" />
      </button>
      {open && (
        <div
          className="chat-compose-model-menu"
          ref={menuRef}
          data-below={placement?.below ? '' : undefined}
          style={placement ? { maxHeight: `min(70vh, 560px, ${placement.maxHeight}px)` } : undefined}
        >
          {showEffort && <div className="chat-compose-option-heading" role="presentation">Model</div>}
          <div role="listbox" aria-label="Model">
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
                {model === item.id && <Check />}
              </button>
              </React.Fragment>
            ))}
          </div>
          {/* The slider moves the effort in place; the menu stays open until a model is picked or it is dismissed. */}
          {showEffort && <EffortSlider effort={effort} onChange={onEffortChange} />}
        </div>
      )}
    </div>
  );
}
