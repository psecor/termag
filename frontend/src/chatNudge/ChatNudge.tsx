// Lab's nudge toward termag's chat, behind chat-ui-nudge-enabled.
// A LaunchPad snackbar
// recommends the chat to a person whose kept choice is Lab: its Switch to chat
// makes the chat where termag opens and goes there; Not now (or its ×) closes
// it and spotlights Lab's own switch, the sidebar's Open in termag, with a
// LaunchPad popover, so they know where it is. Either answer is kept on the
// user (`chatNudgeDismissed`), so the toast doesn't come back on any browser.
import React, { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, ButtonGroup, Dialog, OverlayArrow, Popover, SnackbarRegion, Toast, snackbarQueue, toastRegionStyles } from '@launchpad-ui/components';
import { useAuth } from '../contexts/AuthContext';
import { FLAGS, useFlag } from '../flags';
import { currentUiMode, recordUiMode } from '../chat/uiMode';
import { LP_THEME } from '../launchpad/theme';
import { ensureLaunchPadSprite } from '../launchpad/sprite';
import { CHAT_NUDGE_COPY as COPY, shouldShowChatNudge } from './nudge';
import './chatNudge.css';

// SnackbarRegion spreads its props after its own className, so a className
// passed to it replaces the region's styles (position, stacking): build the
// full class with LaunchPad's own toastRegionStyles instead.
const REGION_CLASS = toastRegionStyles({ placement: 'right', className: `${LP_THEME} chat-nudge-region` });

// Answered in this page: a later response that still says otherwise (the
// switch's own uiMode save can land after the answer) doesn't bring it back.
let answeredInPage = false;
export function resetChatNudgeForTests(): void { answeredInPage = false; }

/** The toast, and the spotlight on `anchor` (Lab's switch to the chat) once it is dismissed. */
export function ChatNudge({ anchor }: { anchor: RefObject<HTMLElement | null> }) {
  const on = useFlag(FLAGS.chatUiNudge, false);
  const { user, updatePreferences } = useAuth();
  const navigate = useNavigate();
  const [answered, setAnswered] = useState(answeredInPage);
  const [spotlight, setSpotlight] = useState(false);
  const switched = useRef(false);
  const show = !answered && shouldShowChatNudge({ on, dismissed: user?.chatNudgeDismissed, mode: currentUiMode() });

  // Saved once, by whichever comes first: Switch to chat, or the toast closing.
  const answer = useCallback(() => {
    if (answeredInPage) return;
    answeredInPage = true;
    setAnswered(true);
    updatePreferences({ chatNudgeDismissed: true }).catch(() => { /* shown again next page load */ });
  }, [updatePreferences]);

  useEffect(() => {
    if (!show) return;
    void ensureLaunchPadSprite();
    let leaving = false;
    const key = snackbarQueue.add({ title: COPY.title, description: COPY.description, status: 'info' }, {
      onClose: () => {
        if (leaving) return;
        answer();
        if (!switched.current) setSpotlight(true);
      },
    });
    return () => { leaving = true; snackbarQueue.close(key); };
  }, [show, answer]);

  // The switch itself glows while the spotlight points at it (chatNudge.css).
  useEffect(() => {
    const el = anchor.current;
    if (!spotlight || !el) return;
    el.setAttribute('data-chat-nudge-spotlight', '');
    return () => el.removeAttribute('data-chat-nudge-spotlight');
  }, [spotlight, anchor]);

  // Answers the toast itself: leaving Lab unmounts it, and a close that comes
  // after that is skipped (`leaving`), so its onClose can't be relied on here.
  const takeIt = (key: string) => {
    switched.current = true;
    recordUiMode('simple');
    answer();
    snackbarQueue.close(key);
    navigate('/chat');
  };

  return (
    <>
      {show && (
        <SnackbarRegion className={REGION_CLASS} aria-label="Recommendation">
          {({ toast }) => (
            <Toast toast={toast} variant="snackbar" className="chat-nudge-toast">
              <ButtonGroup className="chat-nudge-actions">
                <Button variant="primary" size="small" onPress={() => takeIt(toast.key)}>{COPY.switch}</Button>
                <Button variant="minimal" size="small" onPress={() => snackbarQueue.close(toast.key)}>{COPY.dismiss}</Button>
              </ButtonGroup>
            </Toast>
          )}
        </SnackbarRegion>
      )}
      {spotlight && anchor.current && (
        <Popover
          triggerRef={anchor}
          isOpen
          onOpenChange={open => { if (!open) setSpotlight(false); }}
          placement="right"
          offset={12}
          className={`${LP_THEME} chat-nudge-spotlight`}
        >
          <OverlayArrow />
          <Dialog className="chat-nudge-coach" aria-label="Where to switch to termag's chat">
            <p className="chat-nudge-coach-text">{COPY.spotlight}</p>
            <Button variant="primary" size="small" onPress={() => setSpotlight(false)}>{COPY.spotlightDone}</Button>
          </Dialog>
        </Popover>
      )}
    </>
  );
}
