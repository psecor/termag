/// <reference types="vite/client" />
// Generative UI components that live one to a file in this directory
// (Adding a component). Each file's
// default export is a defineGenUiComponent(...): its name, its props as a zod
// schema, the line the agent reads about it, and the React component. The
// catalog, the registry and the action allowlist pick every one up from
// here, so adding a component touches no shared file but the generated prompt.
import type React from 'react';
import type { z } from 'zod';
import type { Ctx } from '../kit';

export interface GenUiComponentDef<S extends z.ZodObject = z.ZodObject> {
  /** The spec's `type`: PascalCase, unique across the catalog. */
  name: string;
  props: S;
  /** What the agent reads about it in the prompt: what it is for, in a sentence or two. */
  description: string;
  /** ['default'] when it draws children. */
  slots?: string[];
  /** Events it emits, for the prompt. */
  events?: string[];
  /** The one event that may send the person's answer (bindings.ts), when it has one. */
  sends?: string;
  /** That event carries the pressed choice (kit.tsx ChoicePress), as a Table's row action does. */
  carriesChoice?: boolean;
  Component: React.ComponentType<Ctx<z.infer<S>>>;
}

/** A component for this directory. Typed so its Component's props are its schema's. */
export function defineGenUiComponent<S extends z.ZodObject>(def: GenUiComponentDef<S>): GenUiComponentDef {
  return def as unknown as GenUiComponentDef;
}

/**
 * The components among `modules` (file → default export), in file name
 * order. Two with one name would silently drop one of them, so that fails at
 * load; catalog.ts checks them against the built-in ones the same way.
 */
export function pluginsOf(modules: Record<string, GenUiComponentDef | undefined>): GenUiComponentDef[] {
  const names = new Set<string>();
  return Object.keys(modules).sort().flatMap(file => {
    const def = modules[file];
    if (!def) return [];
    if (names.has(def.name)) throw new Error(`genui: component ${def.name} is defined twice`);
    names.add(def.name);
    return [def];
  });
}

const modules = import.meta.glob<GenUiComponentDef>(['./*.tsx', '!./*.test.tsx'], { eager: true, import: 'default' });

/** Every component in this directory. */
export const GEN_UI_PLUGINS: GenUiComponentDef[] = pluginsOf(modules);
