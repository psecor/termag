/**
 * `termag ask --model`, behind
 * `ask-model-choice-enabled`, read for the asker (who owns the project, as
 * asks are owner-only) and the target box. Off, an ask's requested model is
 * ignored as an older box agent's would be (no stored choice written, the turn
 * on the box's default, `modelIgnored` saying why), an ask thread's stored
 * tier is not applied, and `project create --model` is ignored with a warning.
 */
import { boolVariation } from './featureFlags';
import type { FlagBox } from './featureFlags';

export const ASK_MODEL_FLAG = 'ask-model-choice-enabled' as const;

/** Why a requested model was ignored with the flag off for the asker and box (a 202, a project create). */
export const ASK_MODEL_OFF_REASON = 'choosing the model is not on for you yet (flag ask-model-choice-enabled)';

export function askModelChoiceOn(
  user: { id: string; googleEmail: string; displayName: string | null; unixUsername: string },
  box: FlagBox | null,
): Promise<boolean> {
  return boolVariation(ASK_MODEL_FLAG, { ...user, displayName: user.displayName ?? '', defaultAgentProvider: '' }, false, box);
}
