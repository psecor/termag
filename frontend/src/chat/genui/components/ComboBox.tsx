// A text field that filters a long list as the person types: LaunchPad's
// ComboBox, its options in a ListBox in a Popover (as registry.tsx's Select
// draws them). The popover renders outside the surface, so it carries LAYER.
import React, { useContext, useEffect, useRef, useState } from 'react';
import { ComboBox, FieldError, Group, IconButton, Input, Label, ListBox, ListBoxItem, Popover, Text } from '@launchpad-ui/components';
import { z } from 'zod';
import { LAYER, SurfaceLocked, useBound, type Ctx } from '../kit';
import { defineGenUiComponent } from './index';
import './ComboBox.css';

/** The longest text the person may type with allowsCustomValue: the input stops there, so a typed value never fails the props check. */
export const COMBOBOX_TEXT_MAX = 200;

const option = z.object({
  value: z.string().min(1).max(100),
  label: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
});

const props = z.object({
  label: z.string().min(1).max(200),
  value: z.string().max(COMBOBOX_TEXT_MAX).nullable().optional(),
  options: z.array(option).min(1).max(200),
  allowsCustomValue: z.boolean().optional(),
  placeholder: z.string().max(100).optional(),
  description: z.string().max(2000).optional(),
  isRequired: z.boolean().optional(),
}).refine(p => new Set(p.options.map(o => o.value)).size === p.options.length, { message: 'option values must be unique', path: ['options'] });

export type ComboBoxProps = z.infer<typeof props>;
type Option = z.infer<typeof option>;

/** What the input shows for a value: its option's label, or the value itself (typed text). */
function textOf(options: Option[], value: string | null | undefined): string {
  if (value == null) return '';
  return options.find(o => o.value === value)?.label ?? value;
}

function ComboBoxEl({ props: p, bindings }: Ctx<ComboBoxProps>) {
  const locked = useContext(SurfaceLocked);
  const [value, setValue] = useBound<string | null>(p.value, bindings?.value);
  const custom = !!p.allowsCustomValue;
  const selected = value != null && p.options.some(o => o.value === value) ? value : null;

  // With allowsCustomValue the field owns its text (React Aria leaves it to us
  // once both the text and the selection are controlled): an option's label
  // means that option, anything else is the value as typed. A value set from
  // elsewhere (another element, the sent answer) replaces the text.
  const [text, setText] = useState(() => textOf(p.options, value));
  const mine = useRef(value);
  useEffect(() => {
    if (!custom || value === mine.current) return;
    mine.current = value;
    setText(textOf(p.options, value));
  }, [custom, value, p.options]);
  const set = (v: string | null) => { mine.current = v; setValue(v); };
  const typed = (t: string) => {
    setText(t);
    // The chosen option's own label keeps that option, though an earlier one may share it.
    if (p.options.find(o => o.value === mine.current)?.label === t) return;
    set(p.options.find(o => o.label === t)?.value ?? (t === '' ? null : t));
  };
  // Without a custom value, only an emptied field clears the choice (React Aria's rule too):
  // text typed to filter leaves it, and the field shows the chosen label again on blur.
  const filter = useRef(textOf(p.options, value));
  const picked = (key: React.Key | null) => {
    if (key != null) {
      const v = String(key);
      if (custom) setText(textOf(p.options, v));
      set(v);
    } else if (!custom && filter.current === '') {
      // The person cleared the field; with a custom value the text says what it is.
      set(null);
    }
  };

  return (
    <ComboBox className="genui-field" defaultItems={p.options} selectedKey={selected} onSelectionChange={picked}
      {...(custom ? { allowsCustomValue: true, inputValue: text, onInputChange: typed } : { onInputChange: (t: string) => { filter.current = t; } })}
      isRequired={p.isRequired} isDisabled={locked}>
      <Label>{p.label}</Label>
      <Group className="genui-combobox-group">
        <Input placeholder={p.placeholder} maxLength={custom ? COMBOBOX_TEXT_MAX : undefined} />
        <IconButton icon="chevron-down" aria-label="Show options" variant="minimal" size="small" />
      </Group>
      {p.description && <Text slot="description" size="small" className="genui-field-description">{p.description}</Text>}
      <FieldError />
      {/* Up to 200 options: the list scrolls rather than fill the window. */}
      <Popover className={LAYER} maxHeight={320}>
        <ListBox<Option>>
          {o => (
            <ListBoxItem id={o.value} textValue={o.label}>
              <Text slot="label">{o.label}</Text>
              {o.description && <Text slot="description" size="small">{o.description}</Text>}
            </ListBoxItem>
          )}
        </ListBox>
      </Popover>
    </ComboBox>
  );
}

export default defineGenUiComponent({
  name: 'ComboBox',
  props,
  description: 'A text field that filters a long list of options as the person types, to pick one (up to 200: repos, people, flags); use a Select for a short list. value is the chosen option\'s value, or null; with allowsCustomValue: true the person may also type something not in the list, and value is then that text. Bind value with $bindState.',
  Component: ComboBoxEl,
});
