import type { AgentStatusValue } from '../types';
import { STATUS_LABEL } from '../types';

/**
 * An agent session's status, drawn in CSS rather than an emoji so its
 * colour follows the status tokens in App.css: a
 * filled green dot while working, half-filled amber while waiting on you, a
 * grey-blue ring when it is ready (idle), a small dim dot when not running.
 * Shape carries the state too, not only colour.
 */
export function StatusDot({ status, title }: { status: AgentStatusValue; title?: string }) {
  return <span className="status-dot" data-status={status} role="img" aria-label={STATUS_LABEL[status]} title={title} />;
}
