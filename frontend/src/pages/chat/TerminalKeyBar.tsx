// The simple UI's terminal on a phone: the workspace's
// Terminal with a key bar under it, for the keys a phone keyboard lacks. Only
// where the side panel is an overlay (SidePanel's `overlay`, a phone width);
// the docked panel and the workspace keep the bare Terminal.
//
// The keys are bytes (utils/terminalKeyBar.ts) sent through the Terminal's
// handle, down the same WebSocket as typing, never through send-keys. Ctrl is
// sticky: armed from the bar, it applies to the next key, the bar's own or
// one typed on the keyboard (Terminal's transformInput), then lets go. The
// keyboard button focuses xterm's textarea inside the tap, which is what
// raises a phone's keyboard (iOS raises it only for a focus in a gesture).
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button, IconButton, ToggleButton } from '@launchpad-ui/components';
import { Icon, type IconName } from '@launchpad-ui/icons';
import { Terminal, type TerminalHandle } from '../../components/Terminal';
import { LP_THEME } from '../../launchpad/theme';
import { ensureLaunchPadSprite } from '../../launchpad/sprite';
import { barKeyBytes, TERMINAL_BAR_KEYS, withStickyCtrl, type BarKeyId } from '../../utils/terminalKeyBar';

// The arrows are LaunchPad's icons: the UI font's ← and → are drawn much
// smaller than its ↑ and ↓. The key's label stays its accessible name's source.
const KEY_ICON: Partial<Record<BarKeyId, IconName>> = {
  up: 'arrow-up-thin', down: 'arrow-down-thin', left: 'arrow-left-thin', right: 'arrow-right-thin',
};

interface BarProps {
  /** The pane's handle, or null while it isn't built. */
  terminal: () => TerminalHandle | null;
  ctrl: boolean;
  onCtrlChange: (armed: boolean) => void;
}

/** The row of keys. A tap on a key keeps the keyboard up if it was up: the key never takes focus from the pane. */
export function TerminalKeyBar({ terminal, ctrl, onCtrlChange }: BarProps) {
  useEffect(() => { void ensureLaunchPadSprite(); }, []);
  // Whether the pane had focus when the tap began, so the key can give it back.
  const hadFocus = useRef(false);
  const press = (id: BarKeyId) => {
    const t = terminal();
    if (!t) return;
    const bytes = barKeyBytes(id, { ctrl, appCursor: t.appCursor() });
    if (bytes !== null) t.send(bytes);
    if (ctrl) onCtrlChange(false);
    if (hadFocus.current) t.focus();
  };
  return (
    <div
      className={`chat-term-keys ${LP_THEME}`}
      role="toolbar"
      aria-label="Terminal keys"
      onPointerDownCapture={() => { hadFocus.current = terminal()?.isFocused() ?? false; }}
      // A mouse-down (also the one a tap emulates) moves focus to what it lands
      // on; stopping it here keeps xterm's textarea focused and the keyboard up.
      // Capture phase: React Aria's press handling stops the event at the button.
      onMouseDownCapture={e => e.preventDefault()}
    >
      <IconButton
        icon="keyboard"
        size="medium"
        variant="minimal"
        className="chat-term-key chat-term-keyboard"
        aria-label="Type in the terminal"
        onPress={() => terminal()?.focus()}
      />
      <div className="chat-term-keys-scroll">
        {TERMINAL_BAR_KEYS.map(k => k.modifier ? (
          <ToggleButton
            key={k.id}
            size="small"
            className="chat-term-key"
            aria-label={k.title}
            isSelected={ctrl}
            onChange={armed => {
              onCtrlChange(armed);
              if (hadFocus.current) terminal()?.focus();
            }}
          >
            {k.label}
          </ToggleButton>
        ) : (
          <Button key={k.id} size="small" className="chat-term-key" aria-label={k.title} data-key={k.id} onPress={() => press(k.id)}>
            {KEY_ICON[k.id] ? <Icon name={KEY_ICON[k.id]!} size="medium" /> : k.label}
          </Button>
        ))}
      </div>
    </div>
  );
}

interface PhoneTerminalProps {
  sessionName: string;
  projectId: string;
  workstream: string;
  instanceId?: string | null;
}

/** The overlay's Terminal tab: the pane, and the key bar under it. */
export function PhoneTerminal({ sessionName, projectId, workstream, instanceId }: PhoneTerminalProps) {
  const handle = useRef<TerminalHandle | null>(null);
  const [ctrl, setCtrlState] = useState(false);
  // The transform runs in xterm's onData, outside React: it reads the ref.
  const ctrlRef = useRef(false);
  const setCtrl = useCallback((armed: boolean) => { ctrlRef.current = armed; setCtrlState(armed); }, []);
  const transformInput = useCallback((data: string) => {
    if (!ctrlRef.current) return data;
    setCtrl(false);
    return withStickyCtrl(data);
  }, [setCtrl]);
  const onReady = useCallback((h: TerminalHandle | null) => { handle.current = h; }, []);
  return (
    <div className="chat-term-phone">
      <div className="chat-term-phone-pane">
        <Terminal
          sessionName={sessionName}
          projectId={projectId}
          workstream={workstream}
          instanceId={instanceId}
          active={true}
          onReady={onReady}
          transformInput={transformInput}
        />
      </div>
      <TerminalKeyBar terminal={() => handle.current} ctrl={ctrl} onCtrlChange={setCtrl} />
    </div>
  );
}
