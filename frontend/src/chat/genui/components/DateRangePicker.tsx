// A start and an end date with a calendar: LaunchPad's DateRangePicker and
// RangeCalendar, drawn as registry.tsx's DatePicker is (its calendar classes
// are genui.css's), the two dates' fields in one Group. The popover renders
// outside the surface, so it carries LAYER.
import React, { useContext } from 'react';
import {
  CalendarCell, CalendarGrid, DateInput, DateRangePicker, DateSegment, Dialog, FieldError, Group, Heading, IconButton,
  Label, Popover, RangeCalendar, Text,
} from '@launchpad-ui/components';
import { parseDate, type CalendarDate } from '@internationalized/date';
import { z } from 'zod';
import { LAYER, SurfaceLocked, useBound, type Ctx } from '../kit';
import { defineGenUiComponent } from './index';
import './DateRangePicker.css';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');

const props = z.object({
  label: z.string().min(1).max(200),
  // Either order: an end typed before its start is the person's to fix in the field, which React
  // Aria marks invalid. A props check here would put a note in the field's place on that keystroke.
  value: z.object({ start: date, end: date }).nullable().optional(),
  min: date.optional(),
  max: date.optional(),
  description: z.string().max(2000).optional(),
  isRequired: z.boolean().optional(),
});

export type DateRangePickerProps = z.infer<typeof props>;
type Range = { start: string; end: string };

function dateOrNull(v: string | null | undefined): CalendarDate | null {
  if (!v) return null;
  try { return parseDate(v); } catch { return null; }
}
/** The picker's range, or none when either end isn't a real date ("2026-02-30"). */
function rangeOrNull(v: Range | null | undefined): { start: CalendarDate; end: CalendarDate } | null {
  const start = dateOrNull(v?.start);
  const end = dateOrNull(v?.end);
  return start && end ? { start, end } : null;
}

function DateRangePickerEl({ props: p, bindings }: Ctx<DateRangePickerProps>) {
  const locked = useContext(SurfaceLocked);
  const [value, setValue] = useBound<Range | null>(p.value, bindings?.value);
  return (
    <DateRangePicker className="genui-field" value={rangeOrNull(value)}
      onChange={r => setValue(r ? { start: r.start.toString(), end: r.end.toString() } : null)}
      minValue={dateOrNull(p.min) ?? undefined} maxValue={dateOrNull(p.max) ?? undefined}
      isRequired={p.isRequired} isDisabled={locked}>
      <Label>{p.label}</Label>
      <Group className="genui-daterangepicker-group">
        <DateInput slot="start">{segment => <DateSegment segment={segment} />}</DateInput>
        <span className="genui-daterangepicker-dash" aria-hidden="true">–</span>
        <DateInput slot="end">{segment => <DateSegment segment={segment} />}</DateInput>
        <IconButton icon="calendar" aria-label="Open calendar" variant="minimal" size="small" />
      </Group>
      {p.description && <Text slot="description" size="small" className="genui-field-description">{p.description}</Text>}
      <FieldError />
      <Popover className={LAYER}>
        <Dialog className="genui-calendar-dialog">
          <RangeCalendar className="genui-calendar">
            <header className="genui-calendar-head">
              <IconButton slot="previous" icon="chevron-left" aria-label="Previous month" variant="minimal" size="small" />
              <Heading level={6} size="small" />
              <IconButton slot="next" icon="chevron-right" aria-label="Next month" variant="minimal" size="small" />
            </header>
            <CalendarGrid>{d => <CalendarCell date={d} />}</CalendarGrid>
          </RangeCalendar>
        </Dialog>
      </Popover>
    </DateRangePicker>
  );
}

export default defineGenUiComponent({
  name: 'DateRangePicker',
  props,
  description: 'A start and an end date, typed or picked on a calendar, for a period ("from … to …"); use a DatePicker for one date. value is {"start": "YYYY-MM-DD", "end": "YYYY-MM-DD"} or null; min and max ("YYYY-MM-DD") bound both dates. Bind value with $bindState.',
  Component: DateRangePickerEl,
});
