// The key bar under a chat transcript. Keys that
// are tmux KEY NAMES go through send-keys with literal:false and no Enter;
// digits (Claude Code's numbered permission options) are typed literally.
import type { AgentStatusValue } from '../types';

export interface QuickKey {
  label: string;
  keys: string;
  literal: boolean;
  enter: boolean;
  title: string;
}

const key = (label: string, keys: string, title: string): QuickKey => ({ label, keys, literal: false, enter: false, title });
const digit = (d: string, title: string): QuickKey => ({ label: d, keys: d, literal: true, enter: false, title });

const COMMON: QuickKey[] = [
  key('Enter', 'Enter', 'Press Enter'),
  key('Esc', 'Escape', 'Press Escape'),
  key('↑', 'Up', 'Arrow up'),
  key('↓', 'Down', 'Arrow down'),
  key('^C', 'C-c', 'Ctrl-C (interrupt)'),
];

/**
 * @param dialogOptions number of numbered options in a visible question
 *   dialog (parsePane's `dialog` block), 0 when none is on screen.
 */
export function quickKeys(
  provider: string | null | undefined,
  status: AgentStatusValue | undefined,
  waitingReason: string | null | undefined,
  dialogOptions = 0,
): QuickKey[] {
  const out: QuickKey[] = [];
  if (dialogOptions > 0) {
    for (let i = 1; i <= Math.min(dialogOptions, 9); i++) out.push(digit(String(i), `Choose option ${i}`));
  } else if (provider === 'claude' && status === 'waiting' && waitingReason === 'approval') {
    out.push(digit('1', 'Option 1 (usually Yes)'), digit('2', 'Option 2'), digit('3', 'Option 3 (usually No)'));
  } else if (provider === 'devin' && status === 'waiting') {
    // Devin's approval list ("1 Yes (Approve once) … 8 No"), picked by digit.
    for (let i = 1; i <= 8; i++) out.push(digit(String(i), i === 1 ? 'Approve once' : i === 8 ? 'No' : `Option ${i}`));
  }
  return out.concat(COMMON);
}
