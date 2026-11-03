/**
 * Product events: what people do with termag, as OpenTelemetry signals in the
 * same telemetry project as everything else. Each event is one log record, `event.name` set, plus one
 * increment of the `termag.product.events` counter by name, both through the
 * global API: with no provider registered (services/otel.ts, nothing to send
 * to) every call here is a no-op, as for services/spawnMetrics.ts.
 *
 * Every event carries `termag.user.id` (the user id, the key the
 * browser SDK and the agents' resources use) and, when a box is involved,
 * `termag.box.id` (the instance id), so a funnel joins browser
 * sessions, agent telemetry and these on the same two keys. Metadata only:
 * attribute values are enums, ids, counts and seconds. Never a prompt, pane
 * text, a brief, an email or a credential; a string value longer than
 * MAX_VALUE_LENGTH is cut, as a guard against a caller passing a message.
 */
import { metrics, type Attributes, type Counter } from '@opentelemetry/api';
import { logs, SeverityNumber } from '@opentelemetry/api-logs';

export const PRODUCT_EVENT_SCOPE = 'termag.product';
export const PRODUCT_EVENT_COUNTER = 'termag.product.events';
const USER = 'termag.user.id';
const BOX = 'termag.box.id';
const MAX_VALUE_LENGTH = 128;

/** The vocabulary. Add here first. */
export const PRODUCT_EVENTS = [
  'project.created',
  'agent.session.started',
  'agent.session.ended',
  'agent.status.changed',
  'workstream.created',
  'share.invited',
  'cloud.session.queued',
  'cloud.session.placed',
  'cloud.session.started',
  'cloud.session.ended',
  'box.provisioned',
  // A new box's first connect: cold provisioning time (services/boxPowerEvents.ts).
  'box.ready',
  'box.resumed',
  // A warm-pool claim, hit or miss, by size, for tuning box-warm-pool-sizes
  // (services/warmPoolSizes.ts).
  'box.pool.claim',
  // Every stop or hibernate asked for, whoever asked, and what the power
  // sweep settled it to (services/boxPowerEvents.ts).
  'box.sleep.requested',
  'box.sleep.settled',
  // Auto-stop idle boxes: the warning, the park,
  // what held a box up, Keep running, and whether a DM reached the owner.
  // Starts are box.resumed, which says who started the box and how long
  // after an auto-park.
  'box.idle.warned',
  'box.parked',
  'box.park.deferred',
  'box.kept_running',
  'box.idle.notice',
  // A resize that ran (services/boxResize.ts): from, to, who asked, how long, how it ended.
  'box.resize',
  'cli.command',
  'slack.command',
] as const;
export type ProductEventName = typeof PRODUCT_EVENTS[number];

/** Who and where: the user id, and the box when there is one. */
export interface ProductEventContext {
  user: string | null | undefined;
  box?: string | null;
}

export type ProductEventValue = string | number | boolean | null | undefined;
export type ProductEventDetail = Record<string, ProductEventValue>;

/** A built record: what emit() sends, exposed for tests and the counter. */
export interface ProductEventRecord {
  name: ProductEventName;
  attributes: Attributes;
}

/**
 * The attributes of one event: the keys, then the detail under `termag.`
 * (`provider` → `termag.provider`), skipping null and undefined. Pure.
 */
export function productEventRecord(name: ProductEventName, ctx: ProductEventContext, detail: ProductEventDetail = {}): ProductEventRecord {
  const attributes: Attributes = { 'event.name': name };
  if (ctx.user) attributes[USER] = ctx.user;
  if (ctx.box) attributes[BOX] = ctx.box;
  for (const [key, value] of Object.entries(detail)) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'number' && !Number.isFinite(value)) continue;
    attributes[`termag.${key}`] = typeof value === 'string' ? value.slice(0, MAX_VALUE_LENGTH) : value;
  }
  return { name, attributes };
}

let counter: Counter | null = null;
function eventsCounter(): Counter {
  counter ??= metrics.getMeter(PRODUCT_EVENT_SCOPE).createCounter(PRODUCT_EVENT_COUNTER, {
    description: 'Product events by event.name (one per log record of the same name)',
  });
  return counter;
}

/** Record one event. Never throws: telemetry must not fail the action it describes. */
export function recordProductEvent(name: ProductEventName, ctx: ProductEventContext, detail: ProductEventDetail = {}): void {
  try {
    const record = productEventRecord(name, ctx, detail);
    logs.getLogger(PRODUCT_EVENT_SCOPE).emit({
      severityNumber: SeverityNumber.INFO,
      severityText: 'INFO',
      body: name,
      attributes: record.attributes,
    });
    const counted: Attributes = { 'event.name': name };
    if (ctx.box) counted[BOX] = ctx.box;
    eventsCounter().add(1, counted);
  } catch (err) {
    console.warn(`[PRODUCT] could not record ${name}:`, (err as Error).message);
  }
}

/** Test hook: the counter is re-created from the current global meter provider. */
export function resetProductEventsForTests(): void {
  counter = null;
}
