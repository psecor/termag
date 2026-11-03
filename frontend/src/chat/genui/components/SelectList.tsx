// A visible list to pick one or several from, each option with a line of
// description: LaunchPad's ListBox drawn inline rather than in a Select's
// popover. A ListBox has no label slot, so label is its aria-label; the
// agent puts a heading or a Card title above it. One picked stays picked, as
// in a RadioGroup. Locked, every option is disabled (a ListBox has no
// isDisabled).
import React, { useContext } from 'react';
import { ListBox, ListBoxItem, Text } from '@launchpad-ui/components';
import { z } from 'zod';
import { SurfaceLocked, useBound, type Ctx } from '../kit';
import { defineGenUiComponent } from './index';
import './SelectList.css';

const id = z.string().min(1).max(100);
const option = z.object({ value: id, label: z.string().min(1).max(200), description: z.string().max(2000).optional() });

const props = z.object({
  label: z.string().min(1).max(200),
  options: z.array(option).min(1).max(50),
  selectionMode: z.enum(['single', 'multiple']).optional(),
  value: z.union([id, z.array(id).max(50)]).nullable().optional(),
}).refine(p => new Set(p.options.map(o => o.value)).size === p.options.length, { message: 'option values must be unique', path: ['options'] });

export type SelectListProps = z.infer<typeof props>;
type Option = z.infer<typeof option>;
type Value = string | string[] | null;

/** The chosen options' values, whichever shape the value arrived in. */
function keysOf(value: Value | undefined, options: Option[]): string[] {
  const list = value == null ? [] : Array.isArray(value) ? value : [value];
  return list.filter(v => options.some(o => o.value === v));
}

function SelectListEl({ props: p, bindings }: Ctx<SelectListProps>) {
  const locked = useContext(SurfaceLocked);
  const multiple = p.selectionMode === 'multiple';
  const [value, setValue] = useBound<Value>(p.value, bindings?.value);
  const chosen = keysOf(value, p.options);
  const selectedKeys = multiple ? chosen : chosen.slice(0, 1);
  return (
    <ListBox<Option> className="genui-selectlist" aria-label={p.label} items={p.options}
      selectionMode={multiple ? 'multiple' : 'single'} selectedKeys={selectedKeys} disallowEmptySelection={!multiple}
      disabledKeys={locked ? p.options.map(o => o.value) : undefined}
      onSelectionChange={keys => {
        // Keys in the options' order, so the answer reads as the list does.
        const picked = keys === 'all' ? p.options.map(o => o.value) : p.options.map(o => o.value).filter(v => keys.has(v));
        setValue(multiple ? picked : picked[0] ?? null);
      }}>
      {o => (
        <ListBoxItem id={o.value} textValue={o.label} className="genui-selectlist-item">
          <Text slot="label">{o.label}</Text>
          {o.description && <Text slot="description" size="small">{o.description}</Text>}
        </ListBoxItem>
      )}
    </ListBox>
  );
}

export default defineGenUiComponent({
  name: 'SelectList',
  props,
  description: 'A visible list to pick from when each option needs a line of description (up to 50); for a few plain options use a RadioGroup or CheckboxGroup, for a long list a ComboBox. selectionMode "single" (default) makes value one option\'s value; "multiple" makes it an array of them. label names the list for screen readers: put a Heading or a Card title above it. Bind value with $bindState.',
  Component: SelectListEl,
});
