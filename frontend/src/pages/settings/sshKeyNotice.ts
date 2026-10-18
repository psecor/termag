import type { SshKeyBoxes } from '../../services/api';

export interface SshKeyNotice {
  text: string;
  /** The change hasn't reached every box yet; only matters for a removal or an unknown outcome. */
  warn: boolean;
}

/** What to tell the owner after a key change, from the boxes the orchestrator did and didn't update. */
export function sshKeyNotice(action: 'added' | 'removed', boxes: SshKeyBoxes | null): SshKeyNotice {
  const noun = action === 'added' ? 'Key added' : 'Key removed';
  if (!boxes) {
    return {
      text: `${noun}, but termag could not check your boxes. Each box is updated when its agent next connects.`,
      warn: true,
    };
  }
  const { updated, pending } = boxes;
  if (updated.length === 0 && pending.length === 0) {
    return {
      text: action === 'added' ? `${noun}. You have no boxes yet; new boxes get it at launch.` : `${noun}. You have no boxes to update.`,
      warn: false,
    };
  }
  const parts = [`${noun}.`];
  if (updated.length > 0) parts.push(`${action === 'added' ? 'Installed on' : 'Removed from'} ${updated.join(', ')}.`);
  if (pending.length > 0) {
    parts.push(action === 'added'
      ? `Not yet on ${pending.join(', ')}; each is updated when its agent next connects.`
      : pending.length === 1
        ? `${pending[0]} still accepts it until its agent next connects.`
        : `${pending.join(', ')} still accept it until their agents next connect.`);
  }
  return { text: parts.join(' '), warn: action === 'removed' && pending.length > 0 };
}
