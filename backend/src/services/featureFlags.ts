// Feature flags, configured by the deployment.
//
// Every flag read in termag names a safe fallback, and with nothing configured
// the app runs entirely on those fallbacks. To turn a gated feature on, set
// TERMAG_FLAGS to a JSON object of flag key to value, for example:
//
//   TERMAG_FLAGS='{"warm-pool-enabled": true, "box-auto-update-enabled": true}'
//
// Values apply to every user and every box. The same values are served to the
// browser by GET /api/flags, so a flag the frontend reads (flags.ts) is set the
// same way.
//
// Every key a caller can read is listed in backend/src/flags.ts, with its kind
// and fallback; the reads are typed by kind, so an unlisted key, or a string
// flag read as a boolean, does not compile. A value of the wrong JSON type in
// TERMAG_FLAGS is ignored and the caller's fallback is used.
//
// Functional singleton like the other services: module state, plain exports.

import type { BoolFlagKey, JsonFlagKey, StringFlagKey } from '../flags';

export type FlagValues = Record<string, unknown>;

// The shapes a flag read is given. Callers pass the signed-in user and, for a
// flag about one box, the box. They are accepted so call sites stay the same
// whichever flag source is wired in; the env-backed source ignores them.
export interface FlagUser {
  id: string;
  googleEmail: string;
  displayName: string;
  unixUsername: string;
  defaultAgentProvider: string;
}

export interface FlagBox {
  id: string;
  name: string;
  kind: string;
}

// A context no user is behind, such as the warm pool's (boxHibernationFlag.ts).
export interface FlagContext {
  kind: string;
  key: string;
  [attribute: string]: unknown;
}

let values: FlagValues = {};

export interface FlagConfig {
  values: FlagValues;
  /** Why a set variable was ignored, for the startup log. */
  ignored?: string;
}

/** Pure: parse TERMAG_FLAGS. Anything malformed is ignored as a whole, with the reason. */
export function flagConfigFromEnv(env: { TERMAG_FLAGS?: string }): FlagConfig {
  const raw = env.TERMAG_FLAGS?.trim();
  if (!raw) return { values: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { values: {}, ignored: 'TERMAG_FLAGS is not valid JSON' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { values: {}, ignored: 'TERMAG_FLAGS must be a JSON object of flag key to value' };
  }
  const out: FlagValues = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (key && value !== undefined && value !== null) out[key] = value;
  }
  return { values: out };
}

export async function initFeatureFlags(env: { TERMAG_FLAGS?: string } = process.env): Promise<void> {
  const cfg = flagConfigFromEnv(env);
  if (cfg.ignored) console.warn(`[FLAGS] ${cfg.ignored}`);
  values = cfg.values;
  const keys = Object.keys(values);
  console.log(keys.length ? `[FLAGS] set: ${keys.join(', ')}` : '[FLAGS] none set; every flag uses its fallback');
}

export async function closeFeatureFlags(): Promise<void> {
  values = {};
}

/**
 * Read one boolean flag. `fallback` is the answer unless TERMAG_FLAGS sets the
 * key to a boolean, which is why every caller passes the safe value rather
 * than the wanted one.
 */
export async function boolVariation(key: BoolFlagKey, _user: FlagUser, fallback: boolean, _box?: FlagBox | null): Promise<boolean> {
  const v = values[key];
  return typeof v === 'boolean' ? v : fallback;
}

/** boolVariation for a context no user is behind (the warm pool's), same fallback rules. */
export async function boolVariationForContext(key: BoolFlagKey, _context: FlagContext, fallback: boolean): Promise<boolean> {
  const v = values[key];
  return typeof v === 'boolean' ? v : fallback;
}

/** A JSON flag: any configured value is returned; the caller validates the shape. */
export async function jsonVariation(key: JsonFlagKey, _user: FlagUser, fallback: unknown, _box?: FlagBox | null): Promise<unknown> {
  return key in values ? values[key] : fallback;
}

/** A string flag: a configured string, else the fallback. */
export async function stringVariation(key: StringFlagKey, _user: FlagUser, fallback: string, _box?: FlagBox | null): Promise<string> {
  const v = values[key];
  return typeof v === 'string' ? v : fallback;
}

/** The configured values, for GET /api/flags. */
export function flagsForBrowser(): FlagValues {
  return { ...values };
}
