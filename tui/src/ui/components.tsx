import { Box, Text, useInput } from 'ink';
import type { ConnectionState } from '../connection.js';
import type { Row } from '../model.js';
import { PILL_COLOR, type Pill } from '../prs.js';
import { NO_AGENT_GLYPH, STATUS_COLOR, STATUS_GLYPH, contextLevel, formatTokens, providerBadge } from '../status.js';
import type { AgentStatusValue } from '../types.js';
import { describePrefix } from '../terminalSocket.js';

// ── header ─────────────────────────────────────────────────────────────────

const CONN_GLYPH: Record<ConnectionState, { glyph: string; color: string }> = {
  live: { glyph: '●', color: 'green' },
  degraded: { glyph: '◌', color: 'yellow' },
  offline: { glyph: '✕', color: 'red' },
};

export function Header(props: {
  me: string; source: string; conn: ConnectionState; working: number; waiting: number; reviewing: number;
  /** PRs that need you (prs.ts prCount); null without a device sign-in or a GitHub connection. */
  prs: number | null;
  width: number;
}) {
  const c = CONN_GLYPH[props.conn];
  return (
    <Box width={props.width} justifyContent="space-between" paddingX={1}>
      <Text>
        <Text bold color="cyan">termag</Text>
        <Text dimColor> · {props.me || '?'} · {props.source}</Text>
      </Text>
      <Text>
        {props.working > 0 && <Text color="green">{props.working} working  </Text>}
        {props.waiting > 0 && <Text color="yellow" bold>{props.waiting} waiting  </Text>}
        {props.reviewing > 0 && <Text color="cyan">{props.reviewing} review  </Text>}
        {props.prs != null && props.prs > 0 && <Text color="yellow">{props.prs} PRs  </Text>}
        <Text color={c.color}>{c.glyph} {props.conn}</Text>
      </Text>
    </Box>
  );
}

// ── project list ───────────────────────────────────────────────────────────

function Glyph({ status }: { status: AgentStatusValue | null }) {
  if (status === null) return <Text dimColor>{NO_AGENT_GLYPH}</Text>;
  return <Text color={STATUS_COLOR[status]} bold={status === 'waiting'}>{STATUS_GLYPH[status]}</Text>;
}

function Badges({ row }: { row: Extract<Row, { kind: 'project' }> }) {
  const b = row.badges;
  const pb = providerBadge(b.provider);
  const lvl = contextLevel(b.contextTokens);
  return (
    <Text>
      {row.workstreamCount > 1 && <Text dimColor>↳{row.workstreamCount} </Text>}
      {b.rateLimited
        ? <Text color="red" bold>RL </Text>
        : b.contextTokens != null && lvl !== 'ok'
          ? <Text color={lvl === 'danger' ? 'red' : 'yellow'}>{formatTokens(b.contextTokens)} </Text>
          : null}
      {pb && <Text color={pb.color}>{pb.badge}</Text>}
      {!pb && <Text dimColor>  </Text>}
      <Text color="cyan">{row.local ? ' ⌂' : '  '}</Text>
    </Text>
  );
}

/** A row's most pressing PR pill and "+N" for the rest (prs.ts lobbyPills); `o` shows the first one's link. */
function Pills({ pills }: { pills: Pill[] }) {
  if (pills.length === 0) return null;
  const [top] = pills;
  const c = PILL_COLOR[top.tone];
  return (
    <Text>
      <Text color={c.color} dimColor={c.dim}>{top.label}</Text>
      {pills.length > 1 && <Text dimColor> +{pills.length - 1}</Text>}
      <Text> </Text>
    </Text>
  );
}

export interface ListProps {
  rows: Row[];
  cursor: number;
  scroll: number;
  height: number;
  width: number;
  flashing: (row: Row) => AgentStatusValue | null;
  pills: (row: Row) => Pill[];
}

export function ProjectList({ rows, cursor, scroll, height, width, flashing, pills }: ListProps) {
  const slice = rows.slice(scroll, scroll + height);
  return (
    <Box flexDirection="column" width={width} height={height}>
      {slice.map((row, i) => {
        const idx = scroll + i;
        const selected = idx === cursor;
        if (row.kind === 'group') {
          return (
            <Box key={row.id} paddingLeft={1}>
              <Text dimColor bold wrap="truncate-end">▾ {row.label} <Text dimColor>({row.count})</Text></Text>
            </Box>
          );
        }
        const flash = flashing(row);
        const bg = selected ? undefined : flash ? STATUS_COLOR[flash] : undefined;
        const fg = flash && !selected ? 'black' : undefined;
        if (row.kind === 'project') {
          const p = row.project;
          const ownerSuffix = p.role === 'collaborator' ? ` (${p.ownerUsername ?? '?'})` : '';
          return (
            <Box key={p.id} paddingLeft={1} justifyContent="space-between" width={width}>
              <Box flexShrink={1}>
                <Text inverse={selected} backgroundColor={bg} color={fg} wrap="truncate-end">
                  {selected ? '▸' : ' '}{p.pinned ? '★' : ' '}<Glyph status={row.status} /> {p.kind === 'metaterm' ? '⚡ ' : ''}{p.name}{ownerSuffix}
                </Text>
              </Box>
              <Box flexShrink={0} paddingRight={1}>
                <Pills pills={pills(row)} />
                <Badges row={row} />
              </Box>
            </Box>
          );
        }
        return (
          <Box key={`${row.project.id}/${row.workstream.id}`} paddingLeft={1} justifyContent="space-between" width={width}>
            <Box flexShrink={1}>
              <Text inverse={selected} backgroundColor={bg} color={fg} wrap="truncate-end">
                {selected ? '▸' : ' '}    ↳ <Glyph status={row.status} /> {row.workstream.name}
                <Text dimColor>{row.workstream.branch && row.workstream.branch !== row.workstream.name ? `  ${row.workstream.branch}` : ''}</Text>
              </Text>
            </Box>
            <Box flexShrink={0} paddingRight={1}>
              <Pills pills={pills(row)} />
            </Box>
          </Box>
        );
      })}
      {rows.length === 0 && <Box paddingLeft={1}><Text dimColor>no projects match</Text></Box>}
    </Box>
  );
}

// ── peek pane ──────────────────────────────────────────────────────────────

export interface PeekProps {
  title: string;
  subtitle: string;
  status: AgentStatusValue | null;
  lines: string[];
  error: string | null;
  ageMs: number | null;
  width: number;
  height: number;
}

export function Peek({ title, subtitle, status, lines, error, ageMs, width, height }: PeekProps) {
  const inner = Math.max(0, height - 2);
  // Keep the last good capture on screen when a poll fails (the capture route
  // is rate-limited per session, so a second viewer causes intermittent 429s);
  // the error takes one line at the bottom instead of replacing the content.
  const bodyLines = Math.max(0, inner - 1 - (error ? 1 : 0));
  const shown = lines.slice(-bodyLines);
  const stale = ageMs != null && ageMs > 6000;
  return (
    <Box flexDirection="column" width={width} height={height} borderStyle="single" borderColor={stale ? 'yellow' : 'gray'} borderDimColor>
      <Box justifyContent="space-between">
        <Text wrap="truncate-end"><Glyph status={status} /> <Text bold>{title}</Text> <Text dimColor>{subtitle}</Text></Text>
        {stale && <Text color="yellow">stale</Text>}
      </Box>
      {shown.map((l, i) => <Text key={i} wrap="truncate-end">{l || ' '}</Text>)}
      {error && <Text color="red" wrap="truncate-end">capture failed: {error}</Text>}
    </Box>
  );
}

// ── footer / prompt / help ─────────────────────────────────────────────────

export function Hints({ inTmux, returnKey, width }: { inTmux: boolean; returnKey: string | null; width: number }) {
  return (
    <Box width={width} paddingX={1}>
      <Text dimColor wrap="truncate-end">
        j/k move · enter attach agent · c attach ctrl · tab peek role · w next waiting · H hand off · / filter · ? help · q quit
        {inTmux && returnKey ? `   (prefix+${returnKey} returns here)` : ''}
      </Text>
    </Box>
  );
}

export function Message({ text, kind, width }: { text: string; kind: 'info' | 'error'; width: number }) {
  return (
    <Box width={width} paddingX={1}>
      <Text color={kind === 'error' ? 'red' : 'cyan'} wrap="truncate-end">{text || ' '}</Text>
    </Box>
  );
}

export interface PromptProps {
  label: string;
  value: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
  onCancel: () => void;
  width: number;
}

/** Minimal single-line editor: printable keys append, backspace deletes, Enter submits, Esc cancels. */
export function Prompt({ label, value, onChange, onSubmit, onCancel, width }: PromptProps) {
  useInput((input, key) => {
    if (key.escape) { onCancel(); return; }
    if (key.return) { onSubmit(value); return; }
    if (key.backspace || key.delete) { onChange(value.slice(0, -1)); return; }
    if (key.ctrl && input === 'u') { onChange(''); return; }
    if (key.ctrl || key.meta || key.upArrow || key.downArrow || key.leftArrow || key.rightArrow || key.tab) return;
    if (input) onChange(value + input);
  });
  return (
    <Box width={width} paddingX={1}>
      <Text color="cyan" bold>{label} </Text>
      <Text>{value}</Text>
      <Text inverse> </Text>
    </Box>
  );
}

export function Help({ width, height, inTmux, returnKey, prefix }: { width: number; height: number; inTmux: boolean; returnKey: string | null; prefix: string }) {
  const pfx = describePrefix(prefix);
  const rows: Array<[string, string]> = [
    ['j / k, ↑ / ↓', 'move; g / G top / bottom; PgUp / PgDn'],
    ['enter', 'attach the agent session: local tmux when it is on this host, else through the orchestrator to its box'],
    ['c', 'attach the ctrl session'],
    ['(attached)', `${pfx} then: d detach · tab agent/ctrl · n/p next/prev project · ${pfx} again sends it · ? reminder`],
    ['tab', 'toggle the peek pane between agent and ctrl'],
    ['w / W', 'jump to the next / previous session that is waiting'],
    ['o', 'show the row\'s top pull request link (PR pills need a device sign-in: termag login)'],
    ['s', 'off for now (the CLI API has no send-keys): attach to type'],
    ['H', 'hand the agent off: it writes a handoff, then y clears and reads it back in, r restarts the pane on it (your own projects)'],
    ['/', 'filter by project, owner or workstream name; Esc clears'],
    ['R', 'refresh now'],
    ['?', 'this help'],
    ['q', 'quit'],
  ];
  return (
    <Box flexDirection="column" width={width} height={height} paddingX={2} paddingY={1} borderStyle="round" borderColor="cyan">
      <Text bold color="cyan">termag tui — keys</Text>
      <Text> </Text>
      {rows.map(([k, d]) => (
        <Box key={k}><Box width={16}><Text bold>{k}</Text></Box><Text wrap="truncate-end">{d}</Text></Box>
      ))}
      <Text> </Text>
      <Text dimColor>glyphs: <Text color="green">●</Text> working  <Text color="yellow">◐</Text> waiting  <Text color={STATUS_COLOR.idle}>○</Text> ready  · not running  — no agent   <Text color="cyan">⌂</Text> session is on this host</Text>
      <Text dimColor>badges: RL rate-limited · 500K+ context warn (yellow) · 1M+ danger (red) · CL/CX/… provider</Text>
      <Text> </Text>
      <Text dimColor>
        {inTmux
          ? `Inside tmux: attach switches this client to the session; prefix+${returnKey ?? '?'} switches back here.`
          : 'Outside tmux: attach runs `tmux attach`; detach (prefix d) returns here.'}
      </Text>
      <Text dimColor>Remote sessions stream through the orchestrator; detach with the prefix chord. Press any key to close.</Text>
    </Box>
  );
}
