// What every generative UI component shares (registry.tsx, components/*.tsx):
// the lock, the props check, two-way binding, and the class LaunchPad's
// popovers need. Kept apart from the registry so a component in its own file
// (components/) imports it without a cycle through the catalog.
import React, { createContext, useState } from 'react';
import { useBoundProp, useStateStore, type BaseComponentProps } from '@json-render/react';
import type { z } from 'zod';
import { LP_THEME } from '../../launchpad/theme';
import { REPEAT_MAX_ITEMS, REPEAT_PATH_PROP } from './limits';

/** True once the surface's answer has gone (generative UI's actions): every input is disabled. */
export const SurfaceLocked = createContext(false);

/**
 * A press that carries a choice (a Table row button, a menu item), handed to
 * the surface's action handler with the event it fires: the choice's id and
 * label, whether it is destructive, and the row it was on, for a Table.
 */
export interface ChoicePress {
  action: string;
  label: string;
  destructive: boolean;
  row?: { key: string; title: string; values: Record<string, unknown> };
}
/** Where a component puts its press before it emits its sending event (GenUiSurface reads it). Null outside a surface. */
export const ChoicePressContext = createContext<React.MutableRefObject<ChoicePress | null> | null>(null);

/** The classes on LaunchPad's popovers, which render outside the surface and need its colour mapping too. */
export const LAYER = `genui-layer ${LP_THEME}`;

export type Ctx<P> = BaseComponentProps<P>;

/** A bound prop's value and setter; an unbound one keeps its own state, so the control still works. */
export function useBound<T>(value: T | undefined, path: string | undefined): [T | undefined, (v: T) => void] {
  const [bound, setBound] = useBoundProp(value, path);
  const [local, setLocal] = useState(value);
  return path ? [bound, setBound] : [local, setLocal];
}

function BadElement({ type, error }: { type: string; error: z.ZodError }) {
  const issue = error.issues[0];
  const where = issue?.path.length ? `${issue.path.join('.')}: ` : '';
  return <div className="genui-bad" role="note">{type} could not be drawn ({where}{issue?.message ?? 'invalid props'})</div>;
}

/**
 * The component behind its props check. A separate element, so a flip
 * between valid and not never reorders hooks. A repeated element (readSpec
 * gives it its list's path) draws a note instead once the list is longer than
 * REPEAT_MAX_ITEMS: a press can set state the spec was not read with.
 */
export function guardedBy<P>(type: string, schema: z.ZodType, Impl: React.ComponentType<Ctx<P>>) {
  return (ctx: Ctx<Record<string, unknown>>) => {
    const { get } = useStateStore();
    const repeatPath = ctx.props[REPEAT_PATH_PROP];
    const items = typeof repeatPath === 'string' ? get(repeatPath) : undefined;
    if (Array.isArray(items) && items.length > REPEAT_MAX_ITEMS) {
      return <div className="genui-bad" role="note">{type} could not be drawn (its list has more than {REPEAT_MAX_ITEMS} items)</div>;
    }
    const parsed = schema.safeParse(ctx.props);
    if (!parsed.success) return <BadElement type={type} error={parsed.error} />;
    return <Impl {...ctx} props={parsed.data as P} />;
  };
}
