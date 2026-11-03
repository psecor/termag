// One ```spec fence drawn as UI. The
// lazily loaded half of generative UI: json-render, zod and the catalog's
// LaunchPad components are about 57 KB gzipped, fetched only when a chat
// with chat-generative-ui-enabled shows a spec (SpecFence.tsx).
//
// json-render's own providers, minus its confirm dialog: a spec's `confirm`
// text never gets a dialog of its own. Anything that fails to read, or
// throws while drawing, shows the fence as the code block it is, under a
// line that says why.
//
// Actions (action.ts, bindings.ts): a catalog action from a Button's press or
// a Form's submit becomes a user message in the chat, with the surface's
// state as its context. A destructive one is confirmed first, in termag's
// dialog. Once sent, the surface is locked and shows what went, here and on
// every later load, from the message in the transcript.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActionProvider, Renderer, StateProvider, ValidationProvider, VisibilityProvider, useStateStore } from '@json-render/react';
import { Button, ButtonGroup, Dialog, Heading, Modal, ModalOverlay, Text } from '@launchpad-ui/components';
import { ensureLaunchPadSprite } from '../../launchpad/sprite';
import { LP_THEME } from '../../launchpad/theme';
import type { CodeFence } from '../codeFence';
import { actionSummary, boundContext, contextOf, formatActionMessage, GEN_UI_ACTIONS, payloadOf, surfaceIdOf, surfaceKey, type ActionPayload } from './action';
import { SentDetails } from './ActionBubble';
import { ARMED, armBindings, armedOf, CHOICE_CARRIERS } from './bindings';
import { ChoicePressContext, type ChoicePress } from './kit';
import { genUiRegistry, SurfaceLocked } from './registry';
import { readSpec } from './spec';
import type { GenUiChat } from './SpecFence';
import { SpecSkeleton } from './SpecSkeleton';

const NO_STATE: Record<string, unknown> = {};

/** What readSpec left out of a spec it could otherwise draw (spec.ts), so a missing part is never a silent one. */
function LeftOut({ notes }: { notes: string[] }) {
  const more = notes.length - 3;
  return (
    <div className="genui-note genui-left-out" role="note">
      Left out of this UI: {notes.slice(0, 3).join('; ')}{more > 0 ? `; and ${more} more` : ''}.
    </div>
  );
}

function CannotDraw({ reason, fallback }: { reason: string; fallback: React.ReactNode }) {
  return (
    <div className="genui-fallback">
      <div className="genui-note" role="note">Could not draw this UI: {reason}</div>
      {fallback}
    </div>
  );
}

class SurfaceBoundary extends React.Component<{ fallback: React.ReactNode; children: React.ReactNode }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(err: unknown) {
    return { error: err instanceof Error ? err.message : 'it failed to render' };
  }
  render() {
    return this.state.error ? <CannotDraw reason={this.state.error} fallback={this.props.fallback} /> : this.props.children;
  }
}

/** Hands the surface's current state to the action handler, which runs outside React's render. */
function StateReader({ into }: { into: React.MutableRefObject<() => Record<string, unknown>> }) {
  const { getSnapshot } = useStateStore();
  into.current = getSnapshot;
  return null;
}

/** termag's confirm for a destructive answer: outside the generated UI, so a spec can't skip or restyle it. */
function ConfirmSend({ payload, onAnswer }: { payload: ActionPayload; onAnswer: (send: boolean) => void }) {
  return (
    <ModalOverlay isOpen isDismissable onOpenChange={open => { if (!open) onAnswer(false); }} className={`genui-layer ${LP_THEME}`}>
      <Modal size="small" className="genui-confirm">
        <Dialog role="alertdialog" className="genui-confirm-dialog">
          <Heading slot="title" level={2} size="medium">Send this to Claude?</Heading>
          <Text elementType="p" slot="subtitle">This answer is marked destructive. Claude acts on it as if you had typed it.</Text>
          <p className="genui-confirm-summary">{actionSummary(payload)}</p>
          <SentDetails payload={payload} open />
          <ButtonGroup className="genui-confirm-buttons">
            <Button variant="minimal" onPress={() => onAnswer(false)}>Cancel</Button>
            <Button variant="destructive" autoFocus onPress={() => onAnswer(true)}>Send</Button>
          </ButtonGroup>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

function randomNonce(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

export default function GenUiSurface({ block, itemKey, streaming, chat, fallback }: {
  block: CodeFence;
  /** The reply's item key, which with the surface id names this copy of the surface (action.ts surfaceKey). */
  itemKey: string;
  /** The reply is still streaming; an open fence with a finished reply is read as whole. */
  streaming: boolean;
  /** Where answers go; null draws the surface with its actions doing nothing. */
  chat: GenUiChat | null;
  /** The fence as a plain code block. */
  fallback: React.ReactNode;
}) {
  const open = block.open && streaming;
  const read = useMemo(() => readSpec(block.text, open), [block.text, open]);
  useEffect(() => { void ensureLaunchPadSprite(); }, []);

  const nonce = useMemo(randomNonce, []);
  const surfaceId = useMemo(() => surfaceIdOf(block.text), [block.text]);
  const spec = useMemo(() => (read.ok ? armBindings(read.spec, nonce) : null), [read, nonce]);
  const answered = chat?.sent.get(surfaceKey(itemKey, surfaceId)) ?? null;
  // Sent from this view: kept until the transcript's own copy arrives, and after a queued send.
  const [sentHere, setSentHere] = useState<ActionPayload | null>(null);
  const [sending, setSending] = useState<ActionPayload | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<{ payload: ActionPayload; answer: (send: boolean) => void } | null>(null);
  const sent = answered ?? sentHere;
  // Read after the destructive confirm, which can stay open while another view answers this surface.
  const sentRef = useRef(sent);
  sentRef.current = sent;
  const busy = useRef(false);
  const readState = useRef<() => Record<string, unknown>>(() => NO_STATE);
  // A press that carries a choice (a Table row button, a menu item), set just before its event runs (kit.tsx).
  const choicePress = useRef<ChoicePress | null>(null);

  const act = useCallback(async (action: string, params: Record<string, unknown>) => {
    const armed = armedOf(params, nonce);
    const press = choicePress.current;
    choicePress.current = null;
    if (!armed || !chat || busy.current || sent || open) return;
    // A Table's rowAction or a menu item carries what was pressed; without it (a binding fired another way) nothing goes.
    const carriesChoice = CHOICE_CARRIERS.has(spec?.elements[armed.source]?.type ?? '');
    if (carriesChoice && !press) return;
    if (!chat.ready) { setProblem('Claude is not ready yet. Try again once it is.'); return; }
    // Only what the surface's inputs are bound to (action.ts boundContext), never state it merely holds.
    const context = contextOf(spec ? boundContext(spec, readState.current()) : {});
    if (!context) { setProblem('There is too much here to send (over 8 KB).'); return; }
    const { [ARMED]: _armed, ...rest } = params;
    const payload = payloadOf(
      action,
      // The pressed row button decides the choice, whatever the binding's own params say.
      carriesChoice && press ? { ...rest, value: press.action, label: press.label } : rest,
      { surfaceId, source: armed.source, label: carriesChoice && press ? press.label : armed.label, ...(carriesChoice && press?.row ? { row: press.row } : {}) },
      context,
    );
    if (!payload) return;
    busy.current = true;
    try {
      if ((armed.confirm || (carriesChoice && press?.destructive)) && !(await new Promise<boolean>(answer => setConfirming({ payload, answer })))) return;
      // Answered in another view while the dialog was up: that answer stands, this one never goes.
      if (sentRef.current) return;
      setProblem(null);
      setSending(payload);
      if (await chat.send(formatActionMessage(payload))) setSentHere(payload);
      else setProblem('That did not go. Try again.');
    } finally {
      setConfirming(null);
      setSending(null);
      busy.current = false;
    }
  }, [nonce, chat, sent, open, surfaceId, spec]);
  // The surface answered elsewhere while termag's confirm was up: close it, sending nothing.
  useEffect(() => { if (sent && confirming) confirming.answer(false); }, [sent, confirming]);

  // json-render's ActionProvider takes its handlers once, at mount: they call the current `act`.
  const actRef = useRef(act);
  actRef.current = act;
  const handlers = useMemo(
    () => Object.fromEntries(GEN_UI_ACTIONS.map(a => [a, (params: Record<string, unknown>) => actRef.current(a, params ?? {})])),
    [],
  );

  // A sent surface shows what was sent: the agent's state under the values that went.
  const initialState = useMemo(() => {
    const base = (read.ok ? read.spec.state : null) ?? NO_STATE;
    return sent ? { ...base, ...sent.context } : base;
  }, [read, sent]);

  if (!read.ok || !spec) return read.ok ? null : read.waiting ? <SpecSkeleton /> : <CannotDraw reason={read.reason} fallback={fallback} />;
  const shown = sending ?? sent;
  return (
    <SurfaceBoundary fallback={fallback}>
      <div className={`genui-surface ${LP_THEME}`} data-streaming={open || undefined} data-sent={sent ? '' : undefined} data-surface={surfaceId}>
        <SurfaceLocked.Provider value={open || !!sending || !!sent}>
          <ChoicePressContext.Provider value={choicePress}>
          {/* Remounted once when the surface is answered, so every view shows exactly the values that went,
              whatever was typed in it; until then each streamed delta only adds what changed (no remount). */}
          <StateProvider key={sent ? 'sent' : 'open'} initialState={initialState}>
            <StateReader into={readState} />
            <VisibilityProvider>
              <ValidationProvider>
                <ActionProvider handlers={handlers}>
                  <Renderer spec={spec} registry={genUiRegistry} loading={open} />
                </ActionProvider>
              </ValidationProvider>
            </VisibilityProvider>
          </StateProvider>
          </ChoicePressContext.Provider>
        </SurfaceLocked.Provider>
        {shown && (
          <div className="genui-sent" role="status">
            <span className="genui-sent-mark" aria-hidden="true">{sending ? '…' : '✓'}</span>
            {sending ? 'Sending' : 'Sent'}: {actionSummary(shown)}
          </div>
        )}
        {!open && read.notes.length > 0 && <LeftOut notes={read.notes} />}
        {problem && !shown && <div className="genui-note genui-problem" role="alert">{problem}</div>}
      </div>
      {confirming && <ConfirmSend payload={confirming.payload} onAnswer={confirming.answer} />}
    </SurfaceBoundary>
  );
}
