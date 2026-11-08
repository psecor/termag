/**
 * The preview links' flags, each
 * off by default and whenever flags are, read for the link's owner (the
 * project's owner, for a publish) and its box, as preview shares' are. The
 * server decides: with `preview-links-enabled` off every publish route
 * answers 404, as if it weren't there.
 */
import { boolVariation, numberVariation } from './featureFlags';
import type { FlagBox, FlagUser } from './featureFlags';
import { clampTtlHours } from './previewLinkRules';

export const PREVIEW_LINKS_FLAG = 'preview-links-enabled';
export const PREVIEW_LINKS_KILL_SWITCH_FLAG = 'preview-links-kill-switch';
export const PREVIEW_LINKS_LINK_AUDIENCE_FLAG = 'preview-links-link-audience-enabled';
export const PREVIEW_LINKS_AGENT_REQUESTS_FLAG = 'preview-links-agent-requests-enabled';
export const PREVIEW_LINKS_WAKE_FLAG = 'preview-links-wake-enabled';
export const PREVIEW_LINKS_TTL_FLAG = 'preview-links-ttl-hours';

/** What a box agent that can open `preview` tunnels and answer `preview-listeners` announces in its hello. */
export const PREVIEW_LINK_CAPABILITY = 'preview-link-v1';

type Box = FlagBox | null | undefined;

export function previewLinksEnabled(user: FlagUser, box: Box): Promise<boolean> {
  return boolVariation(PREVIEW_LINKS_FLAG, user, false, box);
}

/** On: no preview host serves anything (PR 2 reads it on every session check). */
export function previewLinksKilled(user: FlagUser, box: Box): Promise<boolean> {
  return boolVariation(PREVIEW_LINKS_KILL_SWITCH_FLAG, user, false, box);
}

/** The `people` and `link` audiences (phase 2). */
export function previewLinkAudiencesEnabled(user: FlagUser, box: Box): Promise<boolean> {
  return boolVariation(PREVIEW_LINKS_LINK_AUDIENCE_FLAG, user, false, box);
}

/** `termag preview request` (phase 3). */
export function previewLinkRequestsEnabled(user: FlagUser, box: Box): Promise<boolean> {
  return boolVariation(PREVIEW_LINKS_AGENT_REQUESTS_FLAG, user, false, box);
}

/** Wake from the asleep page (phase 3). */
export function previewLinkWakeEnabled(user: FlagUser, box: Box): Promise<boolean> {
  return boolVariation(PREVIEW_LINKS_WAKE_FLAG, user, false, box);
}

/** A link's default lifetime when a publish names none, clamped to 1..168 hours. */
export async function previewLinkTtlDefault(user: FlagUser, box: Box): Promise<number> {
  return clampTtlHours(await numberVariation(PREVIEW_LINKS_TTL_FLAG, user, 24, box));
}
