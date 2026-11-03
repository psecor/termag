// Pick one of a few short options from a row of buttons: LaunchPad's
// ToggleButtonGroup (single selection, which React Aria reads out as a radio
// group) in its elevated look, as the chat's view options draw theirs. The
// label is visible, above the row, and names the group (aria-labelledby): the
// group has no label slot of its own.
import React, { useContext, useId } from 'react';
import { Label, ToggleButton, ToggleButtonGroup } from '@launchpad-ui/components';
import { z } from 'zod';
import { SurfaceLocked, useBound, type Ctx } from '../kit';
import { defineGenUiComponent } from './index';
import './SegmentedControl.css';

const props = z.object({
  label: z.string().min(1).max(200),
  value: z.string().min(1).max(100).nullable().optional(),
  options: z.array(z.object({
    value: z.string().min(1).max(100),
    label: z.string().min(1).max(24),
  })).min(2).max(6),
}).refine(p => new Set(p.options.map(o => o.value)).size === p.options.length, { message: 'option values must be unique', path: ['options'] });

export type SegmentedControlProps = z.infer<typeof props>;

function SegmentedControlEl({ props: p, bindings }: Ctx<SegmentedControlProps>) {
  const locked = useContext(SurfaceLocked);
  const labelId = useId();
  const [value, setValue] = useBound<string | null>(p.value, bindings?.value);
  const selected = value != null && p.options.some(o => o.value === value) ? [value] : [];
  return (
    <div className="genui-segmentedcontrol">
      <Label id={labelId} elementType="span">{p.label}</Label>
      <ToggleButtonGroup className="genui-segmentedcontrol-group" appearance="elevated" aria-labelledby={labelId}
        selectionMode="single" disallowEmptySelection selectedKeys={selected} isDisabled={locked}
        onSelectionChange={keys => { const k = [...keys][0]; if (k != null) setValue(String(k)); }}>
        {p.options.map(o => <ToggleButton key={o.value} id={o.value} appearance="elevated">{o.label}</ToggleButton>)}
      </ToggleButtonGroup>
    </div>
  );
}

export default defineGenUiComponent({
  name: 'SegmentedControl',
  props,
  description: 'A row of 2 to 6 buttons for picking exactly one short option, such as a mode or a period ("Day", "Week", "Month"; 24 characters at most); use a RadioGroup when options need a description, a Select for more. value is the chosen option\'s value: set it in state for the default (none is chosen until then) and bind it with $bindState.',
  Component: SegmentedControlEl,
});
