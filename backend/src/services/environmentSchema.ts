/**
 * The environment definition's JSON Schema (docs/environment.schema.json):
 * every key the design's file has, with their limits.
 * This copy is what the orchestrator ships (docs/ isn't in its image);
 * environmentSchema.test.ts holds it byte-for-byte to the docs one.
 *
 * environmentSchemaErrors says what of a definition the schema refuses, in
 * the warnings' words. termag's readers (services/repoEnvironment.ts) turn
 * each into a warning for a file and a refusal for an inline definition
 * being saved; nothing here throws.
 */
import Ajv2020, { type ErrorObject } from 'ajv/dist/2020';
import schema from './environment.schema.json';

export const ENVIRONMENT_SCHEMA = schema;

const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);

/** At most this many schema errors are named; the rest are counted. */
const MAX_ERRORS = 5;

/** One error as text: where in the definition, and what is wrong. */
function describe(e: ErrorObject): string {
  const at = e.instancePath ? e.instancePath.slice(1).replace(/\//g, '.') : 'the definition';
  if (e.keyword === 'enum') return `${at} must be one of ${(e.params as { allowedValues: unknown[] }).allowedValues.map(v => JSON.stringify(v)).join(', ')}`;
  if (e.keyword === 'additionalProperties') return `${at} has "${(e.params as { additionalProperty: string }).additionalProperty}", which it doesn't take`;
  return `${at} ${e.message ?? 'is not valid'}`;
}

/**
 * What the schema refuses in `data`, one line each, most specific first:
 * an error inside a oneOf branch says more than the oneOf's own "must match
 * exactly one schema". `skip`: top-level keys whose errors the caller reports
 * itself (repoEnvironment.ts reads repos and resources with its own words).
 */
export function environmentSchemaErrors(data: unknown, skip: readonly string[] = []): string[] {
  if (validate(data)) return [];
  const errors = (validate.errors ?? []).filter(e => !skip.some(k => e.instancePath === `/${k}` || e.instancePath.startsWith(`/${k}/`)));
  const deepest = errors.filter(e => e.keyword !== 'oneOf' || !errors.some(o => o !== e && o.instancePath.startsWith(e.instancePath) && o.keyword !== 'oneOf'));
  // One line per place: a value every branch of a oneOf refuses would otherwise read once per branch.
  // The branch whose type it has says the useful thing, so a "must be <type>" gives way to any other.
  const byPath = new Map<string, ErrorObject[]>();
  for (const e of deepest) byPath.set(e.instancePath, [...(byPath.get(e.instancePath) ?? []), e]);
  const lines = [...byPath.values()].map(group => describe(group.find(e => e.keyword !== 'type') ?? group[0]));
  return lines.length > MAX_ERRORS ? [...lines.slice(0, MAX_ERRORS), `and ${lines.length - MAX_ERRORS} more`] : lines;
}
