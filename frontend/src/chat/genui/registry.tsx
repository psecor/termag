// Generative UI's components (catalog.ts), drawn with LaunchPad
// (docs/agents/gotchas.md, LaunchPad). Every control is LaunchPad's; the few
// pieces LaunchPad has nothing for (layout boxes, a static badge, a status
// dot, a KPI tile, a key/value list, a step list) are plain elements, said
// at each. Colours are termag's (genui.css maps the --lp-color-* tokens).
//
// Each component's props are checked against its catalog schema on every
// render, after json-render has resolved $state and $bindState, so a value
// that arrives through state is held to the same rule as one written inline;
// an element that fails draws a one-line note instead of itself.
import React, { useContext, useMemo, useState } from 'react';
import '@launchpad-ui/tokens/index.css';
import {
  Alert, Button, ButtonGroup, Calendar, CalendarCell, CalendarGrid, Cell, Checkbox, CheckboxGroup, Column,
  DateInput, DatePicker, DateSegment, Dialog, Disclosure, DisclosurePanel, FieldError, Form, Group, Heading,
  IconButton, InitialsAvatar, Input, Label, Link, ListBox, ListBoxItem, Meter, NumberField, Popover, ProgressBar,
  Radio, RadioGroup, Row, Select, SelectValue, Separator, Slider, SliderFill, SliderOutput, SliderThumb,
  SliderTrack, Switch, Tab, Table, TableBody, TableHeader, TabList, TabPanel, Tabs, Tag, TagGroup, TagList, Text,
  TextArea, TextField, ToggleButton,
} from '@launchpad-ui/components';
import { Icon } from '@launchpad-ui/icons';
import { defineRegistry } from '@json-render/react';
import { parseDate, type CalendarDate } from '@internationalized/date';
import type { SortDescriptor } from 'react-aria-components';
import { genUiCatalog, propsSchema, safeHref, type GenUiComponent, type GenUiProps } from './catalog';
import { GEN_UI_PLUGINS } from './components';
import { ChoicePressContext, guardedBy, LAYER, SurfaceLocked, useBound, type Ctx } from './kit';

export { SurfaceLocked } from './kit';

/** The registry's own components' props check: their schema is the catalog's. */
function guarded<P>(type: GenUiComponent, Impl: React.ComponentType<Ctx<P>>) {
  return guardedBy(type, propsSchema(type)!, Impl);
}

type Props<K extends GenUiComponent> = GenUiProps<K>;

const TONE_TAG = { default: 'default', info: 'info', success: 'success', warning: 'warning', danger: 'error' } as const;
const headingLevel = (level = 2) => (Math.min(4, Math.max(1, level)) + 2) as 3 | 4 | 5 | 6;
const headingSize = (level = 2) => (level <= 1 ? 'large' : level === 2 ? 'medium' : 'small');
function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return ((words[0]?.[0] ?? '') + (words.length > 1 ? words[words.length - 1][0] : words[0]?.[1] ?? '')).toUpperCase() || '?';
}
function dateOrNull(v: string | null | undefined): CalendarDate | null {
  if (!v) return null;
  try { return parseDate(v); } catch { return null; }
}

// ── Layout ────────────────────────────────────────────────────────────────

// A flex box: layout, not a control, so nothing of LaunchPad's fits.
const Stack = ({ props, children }: Ctx<Props<'Stack'>>) => (
  <div className="genui-stack" data-direction={props.direction ?? 'vertical'} data-gap={props.gap ?? 'medium'}
    data-align={props.align} data-justify={props.justify}>{children}</div>
);

// Columns that fold on a narrow surface (genui.css container queries).
const Grid = ({ props, children }: Ctx<Props<'Grid'>>) => (
  <div className="genui-grid" data-columns={props.columns ?? 2} data-gap={props.gap ?? 'medium'}>{children}</div>
);

// A bordered section: LaunchPad has no card.
const Card = ({ props, children }: Ctx<Props<'Card'>>) => (
  <section className="genui-card" data-tone={props.tone ?? 'default'}>
    {(props.title || props.description) && (
      <header className="genui-card-head">
        {props.title && <Heading level={4} size="medium" className="genui-card-title">{props.title}</Heading>}
        {props.description && <Text elementType="p" size="small" className="genui-card-description">{props.description}</Text>}
      </header>
    )}
    {children != null && <div className="genui-card-body">{children}</div>}
  </section>
);

const HeadingEl = ({ props }: Ctx<Props<'Heading'>>) => (
  <Heading level={headingLevel(props.level)} size={headingSize(props.level)} className="genui-heading">{props.text}</Heading>
);

const TextEl = ({ props }: Ctx<Props<'Text'>>) => (
  <Text elementType="p" size={props.size ?? 'medium'} bold={props.bold} className="genui-text" data-tone={props.tone ?? 'default'}>{props.text}</Text>
);

const SeparatorEl = () => <Separator className="genui-separator" />;

const TabsEl = ({ props, children, bindings }: Ctx<Props<'Tabs'>>) => {
  const [value, setValue] = useBound(props.value, bindings?.value);
  const panels = React.Children.toArray(children);
  const selected = props.tabs.some(t => t.id === value) ? value! : props.tabs[0].id;
  return (
    <Tabs className="genui-tabs" selectedKey={selected} onSelectionChange={key => setValue(String(key))}>
      <TabList aria-label={props.tabs.map(t => t.label).join(', ')}>
        {props.tabs.map(t => <Tab key={t.id} id={t.id}>{t.label}</Tab>)}
      </TabList>
      {props.tabs.map((t, i) => <TabPanel key={t.id} id={t.id} className="genui-tab-panel">{panels[i] ?? null}</TabPanel>)}
    </Tabs>
  );
};

const DisclosureEl = ({ props, children }: Ctx<Props<'Disclosure'>>) => (
  <Disclosure className="genui-disclosure" defaultExpanded={props.defaultExpanded}>
    {({ isExpanded }) => (
      <>
        <Heading level={5} className="genui-disclosure-head">
          <Button slot="trigger" variant="minimal" className="genui-disclosure-trigger">
            <Icon name={isExpanded ? 'chevron-down' : 'chevron-right'} size="small" />
            {props.title}
          </Button>
        </Heading>
        <DisclosurePanel className="genui-disclosure-panel">{children}</DisclosurePanel>
      </>
    )}
  </Disclosure>
);

// ── Data display ──────────────────────────────────────────────────────────

type CellValue = string | number | boolean | null;
type ColumnDef = Props<'Table'>['columns'][number];

function cellText(v: CellValue | undefined, format: ColumnDef['format']): string {
  if (v == null) return '';
  if (format === 'percent' && typeof v === 'number') return `${Math.round(v * 10) / 10}%`;
  if (typeof v === 'number') return v.toLocaleString();
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  return v;
}
const STATUS_WORDS = /^(success|warning|danger|info|running|neutral)$/;
function statusOf(v: string): Props<'Status'>['status'] {
  const s = v.toLowerCase();
  if (STATUS_WORDS.test(s)) return s as Props<'Status'>['status'];
  if (/^(pass|passed|passing|ok|done|merged|approved|healthy|ready|up)$/.test(s)) return 'success';
  if (/^(fail|failed|failing|error|down|blocked|rejected|changes requested)$/.test(s)) return 'danger';
  if (/^(pending|warn|warning|waiting|degraded|draft|review|stale)$/.test(s)) return 'warning';
  if (/^(running|deploying|in progress|building|working)$/.test(s)) return 'running';
  return 'neutral';
}
/** A badge column's tone from common priority and severity words (P0, high, …); plain otherwise. */
function badgeTone(v: string): Props<'Badge'>['tone'] {
  const s = v.toLowerCase();
  if (/^(p0|sev0|sev1|critical|urgent|blocker|high)$/.test(s)) return 'danger';
  if (/^(p1|sev2|medium|major)$/.test(s)) return 'warning';
  if (/^(p2|p3|sev3|low|minor)$/.test(s)) return 'info';
  return 'default';
}
function CellContent({ value, format }: { value: CellValue | undefined; format: ColumnDef['format'] }) {
  const text = cellText(value, format);
  if (!text) return null;
  if (format === 'status') return <StatusDot status={statusOf(text)} label={text} />;
  if (format === 'badge') return <span className="genui-badge" data-tone={badgeTone(text)}>{text}</span>;
  if (format === 'code') return <code className="genui-mono">{text}</code>;
  return <>{text}</>;
}
function compareCells(a: CellValue | undefined, b: CellValue | undefined): number {
  if (a == null || a === '') return b == null || b === '' ? 0 : 1;
  if (b == null || b === '') return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

const ACTIONS_COLUMN = '__actions';

const TableEl = ({ props, emit, on }: Ctx<Props<'Table'>>) => {
  const locked = useContext(SurfaceLocked);
  const pressRef = useContext(ChoicePressContext);
  const [sort, setSort] = useState<SortDescriptor | undefined>(undefined);
  const actions = props.rowActions ?? [];
  // The pressed button and its row go to the surface, then the element's rowAction binding runs.
  const press = (action: (typeof actions)[number], id: string, row: Record<string, unknown>) => {
    if (!pressRef || !on('rowAction').bound) return;
    // Only the cells its columns show: a row's other keys are the agent's, never seen, so they never go back as the answer.
    const values = Object.fromEntries(props.columns.filter(c => c.key in row).map(c => [c.key, row[c.key]]));
    pressRef.current = {
      action: action.id, label: action.label, destructive: action.variant === 'destructive',
      row: { key: id, title: rowTitle(row), values },
    };
    emit('rowAction');
  };
  const keyCol = props.rowKey && props.columns.some(c => c.key === props.rowKey) ? props.rowKey : props.columns[0].key;
  /** What names a row: its rowKey column, as shown. */
  const rowTitle = (row: Record<string, unknown>) => cellText(row[keyCol] as CellValue, props.columns.find(c => c.key === keyCol)?.format);
  const rows = useMemo(() => {
    const seen = new Set<string>();
    const withIds = props.rows.map((row, i) => {
      let id = String(row[keyCol] ?? i);
      if (seen.has(id)) id = `${id}#${i}`;
      seen.add(id);
      return { id, row };
    });
    if (!sort) return withIds;
    const dir = sort.direction === 'descending' ? -1 : 1;
    return [...withIds].sort((x, y) => dir * compareCells(x.row[String(sort.column)], y.row[String(sort.column)]));
  }, [props.rows, keyCol, sort]);
  return (
    <div className="genui-table-wrap">
      <Table aria-label={props.label} className="genui-table" sortDescriptor={sort} onSortChange={setSort}>
        <TableHeader>
          {props.columns.map((c, i) => (
            <Column key={c.key} id={c.key} isRowHeader={i === 0} allowsSorting={c.sortable} data-align={c.align ?? (c.format === 'number' || c.format === 'percent' ? 'end' : 'start')}>
              {c.label}
            </Column>
          ))}
          {actions.length > 0 && <Column key={ACTIONS_COLUMN} id={ACTIONS_COLUMN} data-align="end"><span className="genui-sr">Actions</span></Column>}
        </TableHeader>
        <TableBody>
          {rows.map(({ id, row }) => (
            <Row key={id} id={id}>
              {props.columns.map(c => (
                <Cell key={c.key} data-format={c.format ?? 'text'} data-align={c.align ?? (c.format === 'number' || c.format === 'percent' ? 'end' : 'start')}>
                  <CellContent value={row[c.key]} format={c.format} />
                </Cell>
              ))}
              {actions.length > 0 && (
                <Cell key={ACTIONS_COLUMN} data-align="end" className="genui-row-actions">
                  <ButtonGroup className="genui-buttons">
                    {actions.map(a => (
                      <Button key={a.id} size="small" variant={a.variant ?? 'default'} isDisabled={locked}
                        aria-label={`${a.label}: ${rowTitle(row)}`}
                        onPress={() => press(a, id, row)}>
                        {a.label}
                      </Button>
                    ))}
                  </ButtonGroup>
                </Cell>
              )}
            </Row>
          ))}
        </TableBody>
      </Table>
    </div>
  );
};

// A description list: LaunchPad has none.
const KeyValue = ({ props }: Ctx<Props<'KeyValue'>>) => (
  <dl className="genui-kv">
    {props.items.map((it, i) => (
      <div key={i} className="genui-kv-row">
        <dt>{it.label}</dt>
        <dd className={it.code ? 'genui-mono' : undefined}>{typeof it.value === 'number' ? it.value.toLocaleString() : it.value}</dd>
      </div>
    ))}
  </dl>
);

const TREND_ICON = { up: 'arrow-up-thin', down: 'arrow-down-thin', flat: 'arrow-right-thin' } as const;
const TREND_WORD = { up: 'up', down: 'down', flat: 'unchanged' } as const;
// A KPI tile: LaunchPad has none.
const Stat = ({ props }: Ctx<Props<'Stat'>>) => (
  <div className="genui-stat" data-tone={props.tone ?? 'default'}>
    <span className="genui-stat-label">{props.label}</span>
    <span className="genui-stat-value">
      {typeof props.value === 'number' ? props.value.toLocaleString() : props.value}
      {props.unit && <span className="genui-stat-unit">{props.unit}</span>}
    </span>
    {(props.delta || props.trend) && (
      <span className="genui-stat-delta" data-trend={props.trend ?? 'flat'}>
        {props.trend && <Icon name={TREND_ICON[props.trend]} size="small" aria-hidden />}
        {props.trend && <span className="genui-sr">{TREND_WORD[props.trend]}</span>}
        {props.delta}
      </span>
    )}
    {props.caption && <span className="genui-stat-caption">{props.caption}</span>}
  </div>
);

// A static label: LaunchPad's Tag lives in an interactive TagGroup, not on its own.
const Badge = ({ props }: Ctx<Props<'Badge'>>) => <span className="genui-badge" data-tone={props.tone ?? 'default'}>{props.text}</span>;

const TagGroupEl = ({ props }: Ctx<Props<'TagGroup'>>) => (
  <TagGroup className="genui-tags">
    <Label>{props.label}</Label>
    <TagList>{props.tags.map(t => <Tag key={t.id} id={t.id} size="small" variant={TONE_TAG[t.tone ?? 'default']}>{t.label}</Tag>)}</TagList>
  </TagGroup>
);

const ProgressBarEl = ({ props }: Ctx<Props<'ProgressBar'>>) => (
  <ProgressBar className="genui-progress" variant="bar" value={props.value} maxValue={props.max ?? 100}
    isIndeterminate={props.value == null} valueLabel={props.valueLabel}>
    <Label>{props.label}</Label>
  </ProgressBar>
);

const MeterEl = ({ props }: Ctx<Props<'Meter'>>) => (
  <Meter className="genui-meter" variant="bar" value={props.value} maxValue={props.max ?? 100} valueLabel={props.valueLabel} data-tone={props.tone ?? 'default'}>
    <Label>{props.label}</Label>
  </Meter>
);

// A coloured dot and a word: LaunchPad has no status lozenge.
function StatusDot({ status, label }: { status: Props<'Status'>['status']; label: string }) {
  return <span className="genui-status" data-status={status}><span className="genui-status-dot" aria-hidden="true" />{label}</span>;
}
const StatusEl = ({ props }: Ctx<Props<'Status'>>) => <StatusDot status={props.status} label={props.label} />;

const Avatar = ({ props }: Ctx<Props<'Avatar'>>) => (
  <span className="genui-avatar">
    <InitialsAvatar size={props.size ?? 'medium'} aria-label={props.name}>{initials(props.name)}</InitialsAvatar>
    {props.showName && <span className="genui-avatar-name">{props.name}</span>}
  </span>
);

const LinkEl = ({ props }: Ctx<Props<'Link'>>) => {
  const href = safeHref(props.href);
  if (!href) return <span>{props.text}</span>;
  return <Link href={href} target="_blank" rel="noopener noreferrer" className="genui-link">{props.text}</Link>;
};

const CodeBlockEl = ({ props }: Ctx<Props<'CodeBlock'>>) => {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(props.code).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => {});
  };
  const diff = props.language === 'diff';
  return (
    <div className="md-pre genui-code">
      <div className="md-pre-head">
        <span>{props.language ?? 'code'}</span>
        <Button variant="minimal" size="small" onPress={copy}>{copied ? 'Copied' : 'Copy'}</Button>
      </div>
      <pre><code>{diff
        ? props.code.split('\n').map((line, i) => (
          <span key={i} className="genui-diff-line" data-diff={line.startsWith('+') && !line.startsWith('+++') ? 'add' : line.startsWith('-') && !line.startsWith('---') ? 'del' : line.startsWith('@@') ? 'hunk' : undefined}>{line}{'\n'}</span>
        ))
        : props.code}</code></pre>
    </div>
  );
};

const AlertEl = ({ props }: Ctx<Props<'Alert'>>) => (
  <Alert status={props.status} className="genui-alert">
    {props.title && <Heading level={5}>{props.title}</Heading>}
    <Text elementType="p">{props.text}</Text>
  </Alert>
);

const List = ({ props }: Ctx<Props<'List'>>) => {
  const Tag = props.ordered ? 'ol' : 'ul';
  return <Tag className="genui-list">{props.items.map((it, i) => <li key={i}>{it}</li>)}</Tag>;
};

const STEP_MARK = { done: '✓', current: '●', pending: '○', failed: '✕', skipped: '–' } as const;
const STEP_WORD = { done: 'done', current: 'in progress', pending: 'not started', failed: 'failed', skipped: 'skipped' } as const;
// A step list with each step's state: LaunchPad has none.
const Steps = ({ props }: Ctx<Props<'Steps'>>) => (
  <ol className="genui-steps">
    {props.steps.map((s, i) => (
      <li key={i} className="genui-step" data-status={s.status} aria-current={s.status === 'current' ? 'step' : undefined}>
        <span className="genui-step-mark" aria-hidden="true">{STEP_MARK[s.status]}</span>
        <span className="genui-step-body">
          <span className="genui-step-label">{s.label}<span className="genui-sr"> ({STEP_WORD[s.status]})</span></span>
          {s.detail && <span className="genui-step-detail">{s.detail}</span>}
        </span>
      </li>
    ))}
  </ol>
);

// ── Input ─────────────────────────────────────────────────────────────────

const ButtonEl = ({ props, emit }: Ctx<Props<'Button'>>) => {
  const locked = useContext(SurfaceLocked);
  const submit = props.type === 'submit';
  return (
    <Button variant={props.variant ?? 'default'} type={submit ? 'submit' : 'button'} isDisabled={locked || props.isDisabled}
      onPress={submit ? undefined : () => emit('press')}>
      {props.label}
    </Button>
  );
};

const ButtonGroupEl = ({ children }: Ctx<Props<'ButtonGroup'>>) => <ButtonGroup className="genui-buttons">{children}</ButtonGroup>;

const ToggleButtonEl = ({ props, bindings }: Ctx<Props<'ToggleButton'>>) => {
  const locked = useContext(SurfaceLocked);
  const [selected, setSelected] = useBound(props.selected, bindings?.selected);
  return <ToggleButton isSelected={!!selected} onChange={setSelected} isDisabled={locked}>{props.label}</ToggleButton>;
};

function Description({ text }: { text?: string }) {
  return text ? <Text slot="description" size="small" className="genui-field-description">{text}</Text> : null;
}

const TextFieldEl = ({ props, bindings }: Ctx<Props<'TextField'>>) => {
  const locked = useContext(SurfaceLocked);
  const [value, setValue] = useBound(props.value, bindings?.value);
  return (
    <TextField className="genui-field" value={value ?? ''} onChange={setValue} type={props.type ?? 'text'} isRequired={props.isRequired}
      maxLength={props.maxLength} isDisabled={locked}>
      <Label>{props.label}</Label>
      <Input placeholder={props.placeholder} />
      <Description text={props.description} />
      <FieldError />
    </TextField>
  );
};

const TextAreaEl = ({ props, bindings }: Ctx<Props<'TextArea'>>) => {
  const locked = useContext(SurfaceLocked);
  const [value, setValue] = useBound(props.value, bindings?.value);
  return (
    <TextField className="genui-field" value={value ?? ''} onChange={setValue} isRequired={props.isRequired} isDisabled={locked}>
      <Label>{props.label}</Label>
      <TextArea placeholder={props.placeholder} rows={props.rows ?? 3} />
      <Description text={props.description} />
      <FieldError />
    </TextField>
  );
};

const NumberFieldEl = ({ props, bindings }: Ctx<Props<'NumberField'>>) => {
  const locked = useContext(SurfaceLocked);
  const [value, setValue] = useBound(props.value ?? undefined, bindings?.value);
  return (
    <NumberField className="genui-field" value={value ?? NaN} onChange={v => setValue(Number.isNaN(v) ? (null as unknown as number) : v)}
      minValue={props.min} maxValue={props.max} step={props.step} isRequired={props.isRequired} isDisabled={locked}>
      <Label>{props.label}</Label>
      <Group className="genui-number">
        <Input />
        <IconButton slot="decrement" icon="minus" aria-label="Decrease" variant="minimal" size="small" />
        <IconButton slot="increment" icon="add" aria-label="Increase" variant="minimal" size="small" />
      </Group>
      <Description text={props.description} />
      <FieldError />
    </NumberField>
  );
};

const SelectEl = ({ props, bindings }: Ctx<Props<'Select'>>) => {
  const locked = useContext(SurfaceLocked);
  const [value, setValue] = useBound(props.value ?? undefined, bindings?.value);
  const selected = props.options.some(o => o.value === value) ? value! : null;
  return (
    <Select className="genui-field" selectedKey={selected} onSelectionChange={key => setValue(key == null ? (null as unknown as string) : String(key))}
      placeholder={props.placeholder ?? 'Choose…'} isRequired={props.isRequired} isDisabled={locked}>
      <Label>{props.label}</Label>
      <Button className="genui-select-button">
        <SelectValue />
        <Icon name="chevron-down" size="small" />
      </Button>
      <Description text={props.description} />
      <FieldError />
      <Popover className={LAYER}>
        <ListBox items={props.options}>
          {o => (
            <ListBoxItem id={o.value} textValue={o.label}>
              <Text slot="label">{o.label}</Text>
              {o.description && <Text slot="description" size="small">{o.description}</Text>}
            </ListBoxItem>
          )}
        </ListBox>
      </Popover>
    </Select>
  );
};

const CheckboxEl = ({ props, bindings }: Ctx<Props<'Checkbox'>>) => {
  const locked = useContext(SurfaceLocked);
  const [checked, setChecked] = useBound(props.checked, bindings?.checked);
  return <Checkbox isSelected={!!checked} onChange={setChecked} isDisabled={locked}>{props.label}</Checkbox>;
};

const CheckboxGroupEl = ({ props, bindings }: Ctx<Props<'CheckboxGroup'>>) => {
  const locked = useContext(SurfaceLocked);
  const [value, setValue] = useBound(props.value, bindings?.value);
  return (
    <CheckboxGroup className="genui-group" value={value ?? []} onChange={setValue} isDisabled={locked}>
      <Label>{props.label}</Label>
      {props.options.map(o => <Checkbox key={o.value} value={o.value}>{o.label}</Checkbox>)}
      <Description text={props.description} />
    </CheckboxGroup>
  );
};

const RadioGroupEl = ({ props, bindings }: Ctx<Props<'RadioGroup'>>) => {
  const locked = useContext(SurfaceLocked);
  const [value, setValue] = useBound(props.value ?? undefined, bindings?.value);
  return (
    <RadioGroup className="genui-group" value={value ?? null} onChange={setValue} orientation={props.orientation ?? 'vertical'}
      isRequired={props.isRequired} isDisabled={locked}>
      <Label>{props.label}</Label>
      {props.options.map(o => (
        <Radio key={o.value} value={o.value}>
          <span className="genui-option">
            <span>{o.label}</span>
            {o.description && <span className="genui-option-description">{o.description}</span>}
          </span>
        </Radio>
      ))}
      <Description text={props.description} />
      <FieldError />
    </RadioGroup>
  );
};

const SwitchEl = ({ props, bindings }: Ctx<Props<'Switch'>>) => {
  const locked = useContext(SurfaceLocked);
  const [checked, setChecked] = useBound(props.checked, bindings?.checked);
  return <Switch isSelected={!!checked} onChange={setChecked} isDisabled={locked}>{props.label}</Switch>;
};

const SliderEl = ({ props, bindings }: Ctx<Props<'Slider'>>) => {
  const locked = useContext(SurfaceLocked);
  const min = props.min ?? 0;
  const max = props.max ?? 100;
  const [value, setValue] = useBound(props.value, bindings?.value);
  return (
    <Slider className="genui-slider" value={value ?? min} minValue={min} maxValue={max} step={props.step ?? 1} isDisabled={locked}
      onChange={v => setValue(Array.isArray(v) ? v[0] : v)}>
      <div className="genui-slider-head">
        <Label>{props.label}</Label>
        <SliderOutput className="genui-slider-value">{({ state }) => `${state.getThumbValueLabel(0)}${props.unit ?? ''}`}</SliderOutput>
      </div>
      <SliderTrack className="genui-slider-track">
        <SliderFill />
        <SliderThumb />
      </SliderTrack>
    </Slider>
  );
};

const DatePickerEl = ({ props, bindings }: Ctx<Props<'DatePicker'>>) => {
  const locked = useContext(SurfaceLocked);
  const [value, setValue] = useBound(props.value ?? undefined, bindings?.value);
  return (
    <DatePicker className="genui-field" value={dateOrNull(value)} onChange={d => setValue(d ? d.toString() : (null as unknown as string))}
      minValue={dateOrNull(props.min) ?? undefined} maxValue={dateOrNull(props.max) ?? undefined} isRequired={props.isRequired} isDisabled={locked}>
      <Label>{props.label}</Label>
      <Group className="genui-date">
        <DateInput>{segment => <DateSegment segment={segment} />}</DateInput>
        <IconButton icon="calendar" aria-label="Open calendar" variant="minimal" size="small" />
      </Group>
      <FieldError />
      <Popover className={LAYER}>
        <Dialog className="genui-calendar-dialog">
          <Calendar className="genui-calendar">
            <header className="genui-calendar-head">
              <IconButton slot="previous" icon="chevron-left" aria-label="Previous month" variant="minimal" size="small" />
              <Heading level={6} size="small" />
              <IconButton slot="next" icon="chevron-right" aria-label="Next month" variant="minimal" size="small" />
            </header>
            <CalendarGrid>{date => <CalendarCell date={date} />}</CalendarGrid>
          </Calendar>
        </Dialog>
      </Popover>
    </DatePicker>
  );
};

const FormEl = ({ children, emit }: Ctx<Props<'Form'>>) => {
  const locked = useContext(SurfaceLocked);
  return (
    <Form className="genui-form" onSubmit={e => { e.preventDefault(); if (!locked) emit('submit'); }}>
      {children}
    </Form>
  );
};

// The catalog's actions run in the surface (GenUiSurface), which knows the
// chat they answer; json-render's registry-level handlers are not used.
const noAction = async () => {};

export const { registry: genUiRegistry } = defineRegistry(genUiCatalog, {
  actions: { submit: noAction, choose: noAction, approve: noAction, requestChanges: noAction, cancel: noAction },
  components: {
    Stack: guarded('Stack', Stack),
    Grid: guarded('Grid', Grid),
    Card: guarded('Card', Card),
    Heading: guarded('Heading', HeadingEl),
    Text: guarded('Text', TextEl),
    Separator: guarded('Separator', SeparatorEl),
    Tabs: guarded('Tabs', TabsEl),
    Disclosure: guarded('Disclosure', DisclosureEl),
    Table: guarded('Table', TableEl),
    KeyValue: guarded('KeyValue', KeyValue),
    Stat: guarded('Stat', Stat),
    Badge: guarded('Badge', Badge),
    TagGroup: guarded('TagGroup', TagGroupEl),
    ProgressBar: guarded('ProgressBar', ProgressBarEl),
    Meter: guarded('Meter', MeterEl),
    Status: guarded('Status', StatusEl),
    Avatar: guarded('Avatar', Avatar),
    Link: guarded('Link', LinkEl),
    CodeBlock: guarded('CodeBlock', CodeBlockEl),
    Alert: guarded('Alert', AlertEl),
    List: guarded('List', List),
    Steps: guarded('Steps', Steps),
    Button: guarded('Button', ButtonEl),
    ButtonGroup: guarded('ButtonGroup', ButtonGroupEl),
    ToggleButton: guarded('ToggleButton', ToggleButtonEl),
    TextField: guarded('TextField', TextFieldEl),
    TextArea: guarded('TextArea', TextAreaEl),
    NumberField: guarded('NumberField', NumberFieldEl),
    Select: guarded('Select', SelectEl),
    Checkbox: guarded('Checkbox', CheckboxEl),
    CheckboxGroup: guarded('CheckboxGroup', CheckboxGroupEl),
    RadioGroup: guarded('RadioGroup', RadioGroupEl),
    Switch: guarded('Switch', SwitchEl),
    Slider: guarded('Slider', SliderEl),
    DatePicker: guarded('DatePicker', DatePickerEl),
    Form: guarded('Form', FormEl),
    // The components that live one to a file (components/).
    ...Object.fromEntries(GEN_UI_PLUGINS.map(c => [c.name, guardedBy(c.name, c.props, c.Component)])),
  },
});
