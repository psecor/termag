// A user message a surface sent (action.ts), as the person reads it: what they
// did in one line, and under "What was sent" everything the agent receives,
// so nothing reaches it in the person's name that they cannot see.
import { actionSummary, type ActionPayload } from './action';
import './genui.css';

/** Everything an answer carries but its surface id, as the JSON the agent reads. */
export function SentDetails({ payload, open = false }: { payload: ActionPayload; open?: boolean }) {
  const { surfaceId: _surface, ...shown } = payload;
  return (
    <details className="genui-sent-details" open={open || undefined}>
      <summary>What {open ? 'Claude will receive' : 'was sent'}</summary>
      <pre>{JSON.stringify(shown, null, 2)}</pre>
    </details>
  );
}

export function ActionBubble({ payload }: { payload: ActionPayload }) {
  return (
    <div className="sdk-user-bubble genui-action-bubble" data-action={payload.action}>
      <span className="genui-action-summary">{actionSummary(payload)}</span>
      <span className="genui-action-from">from the UI above</span>
      <SentDetails payload={payload} />
    </div>
  );
}
