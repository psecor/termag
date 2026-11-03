// Generative UI's catalog: the only
// components a ```spec fence in a reply may use, each one's props as a zod
// schema, and a line on what it is for. json-render (@json-render/core)
// turns this into the system prompt that teaches the agent the catalog, so
// what the agent is told and what the chat draws come from one place.
//
// Props are checked again on every render, after json-render has resolved
// $state and $bindState (registry.tsx `guard`), so a value that arrives
// through state is held to the same schema as one written inline. Specs are
// data only: no HTML, no script, no styles, and links only to http(s) and
// mailto. Nothing here fetches anything: there are no image props.
import { defineCatalog } from '@json-render/core';
import { schema } from '@json-render/react/schema';
import { z } from 'zod';
import { GEN_UI_PLUGINS } from './components';

/** A link a spec may open: http(s) or mailto, the same rule as the chat's markdown (markdownParse.ts). */
export function safeHref(url: unknown): string | null {
  return typeof url === 'string' && /^(https?:\/\/[^\s]+|mailto:[^\s@]+@[^\s]+)$/i.test(url) ? url : null;
}

const text = z.string().max(2000);
const label = z.string().min(1).max(200);
const id = z.string().min(1).max(100);
const tone = z.enum(['default', 'info', 'success', 'warning', 'danger']);
const gap = z.enum(['none', 'small', 'medium', 'large']);
/** A choice in a Select, RadioGroup or CheckboxGroup. */
const option = z.object({ value: id, label, description: text.optional() });
const options = z.array(option).min(1).max(50);
/** A cell in a Table row: shown as text, a number, or (by the column's format) a status or badge. */
const cell = z.union([z.string().max(500), z.number(), z.boolean(), z.null()]);

const components = {
  // ── Layout ──────────────────────────────────────────────────────────────
  Stack: {
    props: z.object({
      direction: z.enum(['vertical', 'horizontal']).optional(),
      gap: gap.optional(),
      align: z.enum(['start', 'center', 'end', 'stretch']).optional(),
      justify: z.enum(['start', 'center', 'end', 'between']).optional(),
    }),
    slots: ['default'],
    description: 'Lays its children out in a column (default) or a row. A row wraps on a narrow screen.',
  },
  Grid: {
    props: z.object({
      columns: z.number().int().min(1).max(4).optional(),
      gap: gap.optional(),
    }),
    slots: ['default'],
    description: 'Children in equal columns (default 2), fewer on a narrow screen. Use for Stat tiles and side-by-side Cards.',
  },
  Card: {
    props: z.object({
      title: label.optional(),
      description: text.optional(),
      tone: z.enum(['default', 'muted', 'accent']).optional(),
    }),
    slots: ['default'],
    description: 'A bordered section with an optional title and description over its children. The usual root of a surface.',
  },
  Heading: {
    props: z.object({ text: label, level: z.number().int().min(1).max(4).optional() }),
    description: 'A heading; level 1 is the largest.',
  },
  Text: {
    props: z.object({
      text,
      tone: z.enum(['default', 'muted', 'success', 'warning', 'danger']).optional(),
      size: z.enum(['small', 'medium', 'large']).optional(),
      bold: z.boolean().optional(),
    }),
    description: 'A paragraph of plain text (no markdown).',
  },
  Separator: {
    props: z.object({}),
    description: 'A horizontal rule between sections.',
  },
  Tabs: {
    props: z.object({
      tabs: z.array(z.object({ id, label })).min(1).max(8),
      value: id.optional(),
    }),
    slots: ['default'],
    description: 'Tabs over panels: child N is the panel for tabs[N]. Bind value with $bindState to read the open tab elsewhere.',
  },
  Disclosure: {
    props: z.object({ title: label, defaultExpanded: z.boolean().optional() }),
    slots: ['default'],
    description: 'A section that expands to show its children; collapsed unless defaultExpanded.',
  },

  // ── Data display ────────────────────────────────────────────────────────
  Table: {
    props: z.object({
      label,
      columns: z.array(z.object({
        key: id,
        label,
        align: z.enum(['start', 'end']).optional(),
        sortable: z.boolean().optional(),
        format: z.enum(['text', 'number', 'percent', 'code', 'status', 'badge']).optional(),
      })).min(1).max(12),
      rows: z.array(z.record(z.string(), cell)).max(200),
      rowKey: id.optional(),
      rowActions: z.array(z.object({
        id,
        label: z.string().min(1).max(40),
        variant: z.enum(['default', 'primary', 'minimal', 'destructive']).optional(),
      })).min(1).max(4).optional(),
    }),
    events: ['rowAction'],
    description: 'A table. label names it for screen readers. Each row maps column keys to values; rowKey names the unique column (default: the first). A sortable column sorts on a click. format "status" draws the value as a Status (success, warning, danger, info, running, neutral), "badge" as a Badge, "code" in monospace. rowActions puts those buttons at the end of every row (an outbox, a queue of suggested actions): a press fires the rowAction event, and the action bound to it (usually choose) sends that button\'s id as value with the row it was on.',
  },
  KeyValue: {
    props: z.object({
      items: z.array(z.object({ label, value: z.union([z.string().max(500), z.number()]), code: z.boolean().optional() })).min(1).max(40),
    }),
    description: 'Label and value pairs, e.g. the facts about a PR or a box. code shows the value in monospace (a hash, a path, a command).',
  },
  Stat: {
    props: z.object({
      label,
      value: z.union([z.string().max(50), z.number()]),
      unit: z.string().max(20).optional(),
      delta: z.string().max(30).optional(),
      trend: z.enum(['up', 'down', 'flat']).optional(),
      tone: tone.optional(),
      caption: text.optional(),
    }),
    description: 'A KPI tile: a big value with its label, an optional delta ("+12%") and trend arrow, and a caption.',
  },
  Badge: {
    props: z.object({ text: z.string().min(1).max(40), tone: tone.optional() }),
    description: 'A small coloured label for a status or category.',
  },
  TagGroup: {
    props: z.object({
      label,
      tags: z.array(z.object({ id, label, tone: tone.optional() })).min(1).max(30),
    }),
    description: 'A labelled row of tags (labels, owners, environments). Read-only.',
  },
  ProgressBar: {
    props: z.object({
      label,
      value: z.number().optional(),
      max: z.number().positive().optional(),
      valueLabel: z.string().max(40).optional(),
    }),
    description: 'Progress toward done (value out of max, default 100). Leave value out for an indeterminate bar.',
  },
  Meter: {
    props: z.object({
      label,
      value: z.number(),
      max: z.number().positive().optional(),
      valueLabel: z.string().max(40).optional(),
      tone: z.enum(['default', 'success', 'warning', 'danger']).optional(),
    }),
    description: 'A quantity within a range (disk used, CPU), as a bar. value out of max (default 100).',
  },
  Status: {
    props: z.object({
      status: z.enum(['success', 'warning', 'danger', 'info', 'running', 'neutral']),
      label,
    }),
    description: 'A status lozenge: a coloured dot and a label ("Passing", "Failed", "Deploying").',
  },
  Avatar: {
    props: z.object({ name: label, size: z.enum(['small', 'medium', 'large']).optional(), showName: z.boolean().optional() }),
    description: 'A person\'s initials in a circle, with their name beside it when showName. No images.',
  },
  Link: {
    props: z.object({ text: label, href: z.string().max(2000).refine(v => safeHref(v) !== null, 'http(s) or mailto links only') }),
    description: 'A link that opens in a new tab. http(s) and mailto only.',
  },
  CodeBlock: {
    props: z.object({ code: z.string().max(20000), language: z.string().max(20).optional() }),
    description: 'Code or command output in monospace. language "diff" colours added and removed lines.',
  },
  Alert: {
    props: z.object({
      status: z.enum(['neutral', 'info', 'success', 'warning', 'error']),
      title: label.optional(),
      text,
    }),
    description: 'A callout for something to notice: a warning, an error, a success.',
  },
  List: {
    props: z.object({ items: z.array(text).min(1).max(50), ordered: z.boolean().optional() }),
    description: 'A bulleted list of short text items, numbered when ordered.',
  },
  Steps: {
    props: z.object({
      steps: z.array(z.object({ label, status: z.enum(['done', 'current', 'pending', 'failed', 'skipped']), detail: text.optional() })).min(1).max(20),
    }),
    description: 'A vertical checklist of steps and where each stands, for a multi-step plan or a run in progress.',
  },

  // ── Input ───────────────────────────────────────────────────────────────
  Button: {
    props: z.object({
      label,
      variant: z.enum(['default', 'primary', 'minimal', 'destructive']).optional(),
      type: z.enum(['button', 'submit']).optional(),
      isDisabled: z.boolean().optional(),
    }),
    events: ['press'],
    description: 'A button; its press event runs its `on.press` binding. type "submit" inside a Form submits the form instead (bind the Form\'s submit event). variant "destructive" for anything that removes or overwrites.',
  },
  ButtonGroup: {
    props: z.object({}),
    slots: ['default'],
    description: 'A row of Buttons, spaced as one group.',
  },
  ToggleButton: {
    props: z.object({ label, selected: z.boolean().optional() }),
    description: 'A button that stays pressed or not. Bind selected with $bindState.',
  },
  TextField: {
    props: z.object({
      label,
      value: z.string().max(10000).optional(),
      placeholder: z.string().max(200).optional(),
      description: text.optional(),
      type: z.enum(['text', 'email', 'url']).optional(),
      isRequired: z.boolean().optional(),
      maxLength: z.number().int().positive().max(10000).optional(),
    }),
    description: 'A one-line text input. Bind value with $bindState.',
  },
  TextArea: {
    props: z.object({
      label,
      value: z.string().max(10000).optional(),
      placeholder: z.string().max(200).optional(),
      description: text.optional(),
      rows: z.number().int().min(2).max(12).optional(),
      isRequired: z.boolean().optional(),
    }),
    description: 'A multi-line text input, for a comment or a note. Bind value with $bindState.',
  },
  NumberField: {
    props: z.object({
      label,
      value: z.number().nullable().optional(),
      min: z.number().optional(),
      max: z.number().optional(),
      step: z.number().positive().optional(),
      description: text.optional(),
      isRequired: z.boolean().optional(),
    }),
    description: 'A number input with steppers. Bind value with $bindState.',
  },
  Select: {
    props: z.object({
      label,
      value: id.nullable().optional(),
      options,
      placeholder: z.string().max(100).optional(),
      description: text.optional(),
      isRequired: z.boolean().optional(),
    }),
    description: 'A dropdown to pick one option. value is the chosen option\'s value; bind it with $bindState, and seed it with null (never an empty string) while nothing is chosen.',
  },
  Checkbox: {
    props: z.object({ label, checked: z.boolean().optional() }),
    description: 'A single checkbox. Bind checked with $bindState.',
  },
  CheckboxGroup: {
    props: z.object({
      label,
      value: z.array(id).optional(),
      options,
      description: text.optional(),
    }),
    description: 'Several checkboxes; value is the array of checked option values. Bind it with $bindState. Good for an interactive checklist.',
  },
  RadioGroup: {
    props: z.object({
      label,
      value: id.nullable().optional(),
      options,
      orientation: z.enum(['vertical', 'horizontal']).optional(),
      description: text.optional(),
      isRequired: z.boolean().optional(),
    }),
    description: 'Pick one of a few options, all visible. Bind value with $bindState, and seed it with null (never an empty string) while nothing is chosen.',
  },
  Switch: {
    props: z.object({ label, checked: z.boolean().optional() }),
    description: 'An on/off switch. Bind checked with $bindState.',
  },
  Slider: {
    props: z.object({
      label,
      value: z.number().optional(),
      min: z.number().optional(),
      max: z.number().optional(),
      step: z.number().positive().optional(),
      unit: z.string().max(10).optional(),
    }),
    description: 'A slider over a range (default 0 to 100), with the value shown beside its label and unit after it ("%"). Bind value with $bindState.',
  },
  DatePicker: {
    props: z.object({
      label,
      value: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD').nullable().optional(),
      min: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      max: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      isRequired: z.boolean().optional(),
    }),
    description: 'A date field with a calendar. value is "YYYY-MM-DD"; bind it with $bindState.',
  },
  Form: {
    props: z.object({}),
    slots: ['default'],
    events: ['submit'],
    description: 'Groups inputs. Its submit event runs when a Button with type "submit" inside it is pressed, or Enter in a field, and only once required fields are filled.',
  },
};

// The closed set of actions that send the person's answer back to the agent
// (action.ts, bindings.ts). Each runs only from a Button's press or a Form's
// submit, and sends the surface's whole state as the message's context.
const actions = {
  submit: {
    params: z.object({}),
    description: 'Send the person\'s answer: every value in the surface\'s state goes back to you. Bind it to a Form\'s submit event (with a Button of type "submit" inside) or a Button\'s press.',
  },
  choose: {
    params: z.object({ value: z.union([z.string().max(200), z.number(), z.boolean()]), label: label.optional() }),
    description: 'Send one choice back, e.g. on a "Choose" Button per option. value is what you will read; label is how the choice is shown.',
  },
  approve: {
    params: z.object({ comment: z.string().max(2000).optional() }),
    description: 'Send an approval, with an optional comment (often {"$state": "/comment"} from a TextArea).',
  },
  requestChanges: {
    params: z.object({ comment: z.string().max(2000).optional() }),
    description: 'Send a request for changes, with the comment saying what to change.',
  },
  cancel: {
    params: z.object({}),
    description: 'Tell you the person declined, sending nothing else.',
  },
};

// The components that live one to a file (components/), after these. A name
// both here and there is a mistake that would silently drop one of them.
const plugged = Object.fromEntries(GEN_UI_PLUGINS.map(c => {
  if (Object.prototype.hasOwnProperty.call(components, c.name)) throw new Error(`genui: component ${c.name} is defined twice`);
  return [c.name, { props: c.props, description: c.description, ...(c.slots ? { slots: c.slots } : {}), ...(c.events ? { events: c.events } : {}) }];
}));
const allComponents = { ...components, ...plugged } as typeof components;

export const genUiCatalog = defineCatalog(schema, { components: allComponents, actions });

export type GenUiComponent = keyof typeof components;
export type GenUiProps<K extends GenUiComponent> = z.infer<(typeof components)[K]['props']>;
export const GEN_UI_COMPONENTS = Object.keys(allComponents);

/** A component's props schema, for the render-time check. */
export function propsSchema(type: string): z.ZodType | null {
  return Object.prototype.hasOwnProperty.call(allComponents, type) ? allComponents[type as GenUiComponent].props : null;
}
