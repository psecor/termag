// Which of a spec's event bindings may run.
// json-render runs whatever action an element's `on` or `watch`
// names; here only two kinds survive:
//
// - json-render's built-ins that change the surface's own state (setState,
//   pushState, removeState, validateForm): local, they send nothing;
// - the catalog's actions (action.ts GEN_UI_ACTIONS), and only on a Button's
//   press, a Form's submit or a Table's rowAction (one of its row buttons), so
//   nothing reaches the agent without the person pressing something. A `watch` (fired by a state change) never sends.
//
// Every other binding is dropped. A kept catalog binding is stamped with the
// surface's nonce, the element's key and label, and whether it needs termag's
// confirm; the handler refuses a call without the nonce, so a binding the
// spec chains some other way (onSuccess, a built-in's params) can't send.
// A spec's own `confirm` and its chains are dropped: termag confirms
// destructive answers itself, outside the generated UI.
import type { Spec } from '@json-render/core';
import { isGenUiAction } from './action';
import { GEN_UI_PLUGINS } from './components';

export const LOCAL_ACTIONS = new Set(['setState', 'pushState', 'removeState', 'validateForm']);
/** The events a catalog action may be bound to, by component type. */
const SENDING_EVENTS: Record<string, string> = {
  Button: 'press', Form: 'submit', Table: 'rowAction',
  ...Object.fromEntries(GEN_UI_PLUGINS.filter(c => c.sends).map(c => [c.name, c.sends!])),
};
/** The components whose sending event carries the pressed choice (kit.tsx ChoicePress). */
export const CHOICE_CARRIERS = new Set(['Table', ...GEN_UI_PLUGINS.filter(c => c.carriesChoice).map(c => c.name)]);

export const ARMED = '__genui';
export interface Armed { nonce: string; source: string; label?: string; confirm: boolean }

type Binding = { action?: unknown; params?: Record<string, unknown>; confirm?: unknown; onSuccess?: unknown; onError?: unknown; [k: string]: unknown };

function local(b: Binding): Binding | null {
  if (typeof b.action !== 'string' || !LOCAL_ACTIONS.has(b.action)) return null;
  const { confirm: _confirm, ...rest } = b;
  return rest;
}

function each(value: unknown, keep: (b: Binding) => Binding | null): unknown {
  const list = (Array.isArray(value) ? value : [value]).filter((b): b is Binding => !!b && typeof b === 'object');
  const kept = list.map(keep).filter((b): b is Binding => b !== null);
  if (!kept.length) return undefined;
  return Array.isArray(value) ? kept : kept[0];
}

/** A Form's submit button (its first Button of type "submit"): what names the answer and whether it is destructive. */
function submitButton(spec: Spec, formKey: string): Record<string, unknown> | undefined {
  const queue = [...(spec.elements[formKey]?.children ?? [])];
  const seen = new Set<string>();
  while (queue.length) {
    const key = queue.shift()!;
    if (seen.has(key)) continue;
    seen.add(key);
    const el = spec.elements[key];
    if (!el) continue;
    const props = (el.props ?? {}) as Record<string, unknown>;
    if (el.type === 'Button' && props.type === 'submit') return props;
    queue.push(...(el.children ?? []), ...Object.values(el.slots ?? {}).flat());
  }
  return undefined;
}

/** The spec with only the bindings allowed to run, catalog ones stamped. A new spec; the input is not changed. */
export function armBindings(spec: Spec, nonce: string): Spec {
  const elements: Spec['elements'] = {};
  for (const [key, el] of Object.entries(spec.elements)) {
    const props = (el.props ?? {}) as Record<string, unknown>;
    const next = { ...el } as Spec['elements'][string] & { on?: Record<string, unknown>; watch?: Record<string, unknown> };
    if (el.on) {
      const on: Record<string, unknown> = {};
      for (const [event, value] of Object.entries(el.on as Record<string, unknown>)) {
        const kept = each(value, b => {
          if (!isGenUiAction(b.action)) return local(b);
          if (SENDING_EVENTS[el.type] !== event) return null;
          // A Form sends from its submit button: its label names the answer, and its variant decides the confirm.
          const pressed = el.type === 'Form' ? submitButton(spec, key) ?? {} : props;
          const label = typeof pressed.label === 'string' ? pressed.label : undefined;
          const armed: Armed = {
            nonce,
            source: key,
            ...(label ? { label } : {}),
            confirm: pressed.variant === 'destructive' || !!b.confirm,
          };
          return { action: b.action, params: { ...(b.params ?? {}), [ARMED]: armed } };
        });
        if (kept !== undefined) on[event] = kept;
      }
      next.on = Object.keys(on).length ? on as never : undefined;
      if (!next.on) delete next.on;
    }
    if (el.watch) {
      const watch: Record<string, unknown> = {};
      for (const [path, value] of Object.entries(el.watch as Record<string, unknown>)) {
        const kept = each(value, local);
        if (kept !== undefined) watch[path] = kept;
      }
      next.watch = Object.keys(watch).length ? watch as never : undefined;
      if (!next.watch) delete next.watch;
    }
    elements[key] = next;
  }
  return { ...spec, elements };
}

/** The stamp on a call's params, when it is this surface's; null for anything else. */
export function armedOf(params: unknown, nonce: string): Armed | null {
  const a = params && typeof params === 'object' ? (params as Record<string, unknown>)[ARMED] : null;
  if (!a || typeof a !== 'object') return null;
  const o = a as Record<string, unknown>;
  return o.nonce === nonce && typeof o.source === 'string' ? o as unknown as Armed : null;
}
