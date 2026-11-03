// The composer under an SDK chat: the status line, the sign-in and trust
// notes, the message box with its images, model, effort, context ring,
// dictation and Send or Stop, and the notes under it (above it in the chrome
// refresh, with the refresh's Stop, ComposerStop). Moved here from
// SdkChatView unchanged; its state is useSdkChat's.
import type React from 'react';
import { createPortal } from 'react-dom';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { isSendKey } from '../../chat/compose';
import { TerminalHoldNotice } from '../../chat/TerminalHoldNotice';
import { costSinceCleared, sendGoesLive, stopTitle } from '../../chat/sdkChat';
import { chatProvider } from '../../chat/simpleChat';
import { DictationButton, DictationNote } from '../../chat/DictationButton';
import { ModelPicker } from '../../chat/ModelPicker';
import { chatAgentName } from '../../chat/composer';
import { CHAT_ATTACHMENT_ACCEPT, CHAT_IMAGE_ACCEPT, filesOf } from '../../chat/chatImageData';
import { ComposerImages } from '../../chat/ChatImages';
import { ContextRing } from '../../chat/ContextRing';
import { PlusIcon, SendIcon, StopIcon } from '../../chat/ComposerIcons';
import { ClaudeLoginCard } from '../../chat/ClaudeLoginCard';
import { claudeSignInApplies } from '../../chat/claudeLogin';
import type { Project } from '../../types';
import { MAX_TEXT, type SdkChat } from './useSdkChat';
import { useChatChrome } from './chatChrome';
import { ComposerStop } from './ComposerStop';
import { useSessionRefDrop } from '../../chat/useSessionRefDrop';

export function SdkComposer({ s, project, workstream, unseen = false, onJump = () => {}, className, above, barStart, statusLine, placeholderWho, placeholder, noReserve, drawer }: {
  s: SdkChat; project: Project; workstream: string;
  /** The transcript has output below the fold: the conversation's "↓ new output". */
  unseen?: boolean; onJump?: () => void;
  /** For a view other than the conversation (the file view): a class on the root, what goes above the status line, and what leads the bar. */
  className?: string; above?: React.ReactNode; barStart?: React.ReactNode;
  /** The file view: one fixed-height line in place of the status line, which says everything it has to say there. */
  statusLine?: React.ReactNode;
  /** Who the placeholder names ("Message <who>…"); the conversation's is the model the picker shows (chat/composer.ts chatAgentName). */
  placeholderWho?: string;
  /** The whole placeholder, where the session says what it's for (a review session). */
  placeholder?: string;
  /** No reserved space for the trust note while the history loads (under a file, a row that comes and goes). */
  noReserve?: boolean;
  /** On the composer's top edge, under the status line: the chat's subagents (Subagents.tsx AgentsDrawer). */
  drawer?: React.ReactNode;
}) {
  const jumpToBottom = onJump;
  const { refresh = false } = useChatChrome();
  const {
    ringActions,
    box,
    recovery,
    chat,
    sendsLive,
    liveChrome,
    remembered,
    trust,
    canTrust,
    imageInput,
    pdfInput,
    effortInput,
    loadError,
    trustNoun,
    stored,
    trusting,
    model,
    modelPick,
    modelReady,
    modelOpen,
    setModelOpen,
    modelOptions,
    effort,
    effortPending,
    chooseModel,
    chooseEffort,
    opening,
    runnerReady,
    showSteps,
    loading,
    reserve,
    text,
    setText,
    composer,
    dictation,
    sendError,
    reclaiming,
    images,
    setImages,
    imageNote,
    picker,
    send,
    returnToChat,
    attach,
    trustRepo,
    stop,
    background,
    subagents,
    control,
    confirmStop,
    setConfirmStop,
    stopMenu,
    setStopMenu,
    requestStop,
    mainStop,
    running,
    stopSplit,
    openFull,
    setupFailed,
    showHold,
    status,
    canSend,
    total,
    settingUp,
    takesImages,
    hasDraft,
    repo,
  } = s;
  // A session dragged in from the sidebar goes into the message as a reference to it (chat/sessionRef.ts).
  const refDrop = useSessionRefDrop({ input: composer, text, setText: t => { dictation.onEdit(); setText(t); }, max: MAX_TEXT });
  // The model the picker shows (the remembered one until history reports), which the placeholder names.
  const shownModel = model ?? (modelReady ? null : remembered?.model ?? null);
  const who = placeholderWho ?? chatAgentName(shownModel, modelOptions);
  const messagePrompt = placeholder ?? (who ? `Message ${who}…` : 'Message…');
  const notes = (
    <>
      <DictationNote dictation={dictation} />
      {takesImages && imageNote && <div className="chat-composer-note" data-error="">{imageNote}</div>}
      {showHold && (
        <TerminalHoldNotice busy={reclaiming || opening} onReturn={() => { void returnToChat(); }} onFullUi={() => { void openFull(); }} refresh={refresh} />
      )}
      {sendError && <div className="chat-composer-note" data-error="">{sendError}</div>}
      {refDrop.note && <div className="chat-composer-note" data-error="">{refDrop.note}</div>}
    </>
  );
  return (
    <div className={className ? `chat-bottom ${className}` : 'chat-bottom'}>
      {above}
      {unseen && <button type="button" className="chat-jump" onClick={jumpToBottom}>↓ new output</button>}
      {claudeSignInApplies(chatProvider(project, workstream)) && (
        // A stored transcript reads without the box; its sign-in waits for a send.
        <ClaudeLoginCard projectId={project.id} owner={project.role !== 'collaborator'} enabled={!stored} box={box?.status}
          hostShowsBox={Boolean(loadError || settingUp || showHold || recovery)} authFailure={chat.authFailure} />
      )}
      {((reserve && !noReserve) || (trust && !trust.trusted)) && (
        <div className="chat-trust" role={reserve ? undefined : 'note'} aria-hidden={reserve || undefined} data-reserved={reserve || undefined}>
          <span>Claude can read {repo ?? 'this project'} but can't run commands or edit files in this session until the {trustNoun} is trusted.</span>
          {canTrust || (reserve && project.role !== 'collaborator')
            ? <button type="button" className="btn-tiny" onClick={trustRepo} disabled={trusting || liveChrome == null} tabIndex={reserve ? -1 : undefined}>{trusting ? 'Trusting…' : `Trust this ${trustNoun}`}</button>
            : <span className="chat-trust-note">Only the project's owner can trust it.</span>}
        </div>
      )}
      {/* The chrome refresh's notes sit above the composer, past its rounded corner; none, no line. */}
      {refresh && <div className="chat-composer-notes" data-above="">{notes}</div>}
      {statusLine ?? (
        <div className="chat-status" data-tone={status.tone === 'idle' ? 'idle' : status.tone === 'error' ? 'offline' : showSteps && !runnerReady ? 'setup' : 'working'} role="status" aria-live="polite">
          {!recovery && chat.running && status.tone === 'working' && <span className="sdk-spinner" aria-hidden="true" />}{status.text}
        </div>
      )}
      {drawer}
      {/* One surface: the images, the text, and a bar with the model on the left and
          attach, dictate and send (or stop) on the right. Send shows once there is
          something to send. */}
      <form className="chat-composer" onSubmit={e => { e.preventDefault(); void send(); }} {...(canSend ? refDrop.handlers : {})} data-ref-drop={refDrop.over || undefined}>
        {takesImages && <ComposerImages images={images} onRemove={id => setImages(held => held.filter(i => i.id !== id))} />}
        <textarea
          ref={composer}
          className="chat-input"
          value={text}
          onChange={e => { dictation.onEdit(); setText(e.target.value.slice(0, MAX_TEXT)); }}
          onPaste={takesImages ? e => {
            const files = filesOf(e.clipboardData.files);
            if (!files.length) return;
            // An image copied with its caption (a web page) pastes both; a bare image pastes nothing else.
            if (!e.clipboardData.getData('text/plain')) e.preventDefault();
            void attach(files);
          } : undefined}
          onKeyDown={e => {
            if (dictation.onKeyDown(e)) return;
            // Enter sends, Shift+Enter is a newline: the runner takes the message as is.
            if (isSendKey({ key: e.key, shiftKey: e.shiftKey, isComposing: e.nativeEvent.isComposing })) { e.preventDefault(); void send(); }
          }}
          placeholder={s.sendRefusal ? s.sendRefusal.reason : setupFailed ? 'Setup failed' : !runnerReady && !loading ? `${messagePrompt} (sent when it is ready)` : chat.running ? (sendGoesLive(chat, sendsLive) ? `${messagePrompt} (it reads this at its next step)` : `${messagePrompt} (sent after this turn)`) : messagePrompt}
          rows={1}
          disabled={!canSend}
        />
        <div className="chat-composer-bar">
          {barStart}
          <ModelPicker model={shownModel} options={modelOptions} onChange={chooseModel} open={modelOpen} onOpenChange={setModelOpen} disabled={!modelReady}
            effort={effortInput ? effort : null} onEffortChange={chooseEffort} />
          {(modelPick || (effortInput && effortPending)) && <span className="chat-composer-note">From your next message</span>}
          <div className="chat-compose-actions">
            <ContextRing usage={chat.usage} costUsd={total} sinceClearedUsd={costSinceCleared(chat)} compactedFrom={chat.compactedFrom ?? null} actions={ringActions} />
            {(imageInput || reserve) && (
              <>
                <button type="button" className="chat-icon-btn chat-attach" aria-label={pdfInput ? 'Attach images or PDFs' : 'Attach images'} title={pdfInput ? 'Attach images or PDFs (or drop or paste them)' : 'Attach images (or drop or paste them)'}
                  onClick={() => picker.current?.click()} disabled={!takesImages}
                  data-reserved={!imageInput || undefined} aria-hidden={!imageInput || undefined} tabIndex={!imageInput ? -1 : undefined}>
                  <PlusIcon />
                </button>
                <input ref={picker} type="file" accept={pdfInput ? CHAT_ATTACHMENT_ACCEPT : CHAT_IMAGE_ACCEPT} multiple hidden
                  onChange={e => { void attach(Array.from(e.target.files ?? [])); e.target.value = ''; }} />
              </>
            )}
            <DictationButton dictation={dictation} disabled={!canSend} />
            {/* Stop and Send share one slot that is never narrower than a button, so neither one
                coming or going moves the ring and its popover. */}
            <div className="chat-compose-end">
            {running && refresh && <ComposerStop s={s} />}
            {running && !refresh && control === 'split' && (
              <div className="chat-stop-split" ref={stopSplit}>
                <button type="button" className="chat-stop-btn chat-stop-main" onClick={mainStop} aria-label="Stop" title={stopTitle(background, 'split')}>
                  <StopIcon />
                </button>
                <button
                  type="button"
                  className="chat-stop-caret"
                  aria-label="More ways to stop"
                  aria-haspopup="menu"
                  aria-expanded={stopMenu}
                  onClick={() => setStopMenu(m => !m)}
                ><span className="chat-compose-caret" aria-hidden="true" /></button>
                {stopMenu && (
                  <div className="chat-stop-menu" role="menu">
                    <button type="button" role="menuitem" onClick={() => requestStop('all')}>
                      <span className="chat-stop-menu-label">Stop everything</span>
                      <span className="chat-stop-menu-hint">{background.length ? `Also ends ${background.length === 1 ? 'the background task' : `the ${background.length} background tasks`}` : 'Ends the turn and anything it starts in the background'}</span>
                    </button>
                  </div>
                )}
              </div>
            )}
            {running && !refresh && control === 'background' && (
              <button type="button" className="chat-stop-btn chat-stop-wide" onClick={mainStop} title={stopTitle(background, control)}>
                <StopIcon /><span>Stop background work</span>
              </button>
            )}
            {running && !refresh && control === 'plain' && (
              <button type="button" className="chat-stop-btn" onClick={mainStop} aria-label="Stop" title={stopTitle(background, control)}>
                <StopIcon />
              </button>
            )}
            {hasDraft && (
              <button type="submit" className="chat-send-btn" aria-label="Send" title="Send (Enter)" disabled={!canSend}>
                <SendIcon />
              </button>
            )}
            </div>
          </div>
        </div>
      </form>
      {confirmStop && createPortal(
        <ConfirmDialog
          message={confirmStop === 'turn' ? <>
            Stop Claude? Background commands keep running, but {subagents.length === 1 ? 'the background subagent ends' : `the ${subagents.length} background subagents end`} with the stop:
            <ul className="chat-stop-tasks">{subagents.map((t, i) => <li key={i}>{t.description}</li>)}</ul>
          </> : <>
            Stop Claude? This ends the turn now, and with it {background.length === 1 ? 'the background task' : `the ${background.length} background tasks`} it started:
            <ul className="chat-stop-tasks">{background.map((t, i) => <li key={i}>{t.description}</li>)}</ul>
            A <code>termag ask</code> among them stops waiting, but the ask keeps running on its box (its commits still open a draft PR); its reply won't come back to this session.
          </>}
          confirmLabel={confirmStop === 'turn' ? 'Stop' : 'Stop everything'}
          onConfirm={() => { const scope = confirmStop; setConfirmStop(null); stop(scope); }}
          onCancel={() => setConfirmStop(null)}
        />,
        document.body,
      )}
      {/* A line kept under the composer for its notes, so one appearing doesn't push it up. */}
      {!refresh && <div className="chat-composer-notes">{notes}</div>}
    </div>
  );
}
