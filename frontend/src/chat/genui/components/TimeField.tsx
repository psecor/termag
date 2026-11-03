// A time of day, typed as hours and minutes: LaunchPad's TimeField, its
// segments in a DateInput. The DateInput takes LaunchPad's input look
// (inputStyles) itself: wrapping it in a Group, as DatePicker's is, would hand
// the TimeField's field props to both.
import React, { useContext } from 'react';
import { DateInput, DateSegment, FieldError, inputStyles, Label, Text, TimeField } from '@launchpad-ui/components';
import { parseTime, type Time } from '@internationalized/date';
import { z } from 'zod';
import { SurfaceLocked, useBound, type Ctx } from '../kit';
import { defineGenUiComponent } from './index';
import './TimeField.css';

const props = z.object({
  label: z.string().min(1).max(200),
  value: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM, 24-hour').nullable().optional(),
  description: z.string().max(2000).optional(),
  isRequired: z.boolean().optional(),
});

export type TimeFieldProps = z.infer<typeof props>;

function timeOrNull(v: string | null | undefined): Time | null {
  if (!v) return null;
  try { return parseTime(v); } catch { return null; }
}
const pad = (n: number) => String(n).padStart(2, '0');
/** "HH:MM", 24-hour: Time's own toString adds seconds. */
export const hhmm = (t: { hour: number; minute: number }) => `${pad(t.hour)}:${pad(t.minute)}`;

function TimeFieldEl({ props: p, bindings }: Ctx<TimeFieldProps>) {
  const locked = useContext(SurfaceLocked);
  const [value, setValue] = useBound<string | null>(p.value, bindings?.value);
  return (
    <TimeField className="genui-field" granularity="minute" value={timeOrNull(value)}
      onChange={t => setValue(t ? hhmm(t) : null)} isRequired={p.isRequired} isDisabled={locked}>
      <Label>{p.label}</Label>
      <DateInput className={`${inputStyles()} genui-timefield-input`}>{segment => <DateSegment segment={segment} />}</DateInput>
      {p.description && <Text slot="description" size="small" className="genui-field-description">{p.description}</Text>}
      <FieldError />
    </TimeField>
  );
}

export default defineGenUiComponent({
  name: 'TimeField',
  props,
  description: 'A time of day, typed as hours and minutes. value is "HH:MM" on a 24-hour clock ("09:30", "17:00") or null; the field shows it in the person\'s own 12- or 24-hour format. Pair it with a DatePicker for a date and a time. Bind value with $bindState.',
  Component: TimeFieldEl,
});
