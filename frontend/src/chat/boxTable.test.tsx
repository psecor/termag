import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BlockView } from './Blocks';
import { parseBoxTable, splitBoxTables } from './boxTable';
import { parsePane } from './paneChat';

// Claude Code's reply with a 2-column markdown table, drawn as a box grid at
// the pane's 200-column width, with cells that wrap onto several rows: the
// shape from the bug report.
const PANE = readFileSync(new URL('./fixtures/claude-box-table.pane.txt', import.meta.url), 'utf8');
const html = (text: string) => renderToStaticMarkup(<BlockView block={{ kind: 'agent', text }} agentLabel="claude" />);

describe('box-drawn tables in the pane chat', () => {
  const agent = parsePane(PANE, { provider: 'claude', role: 'agent' }).blocks.find(b => b.kind === 'agent')!;

  it('keeps the grid rows in the agent block, row for row', () => {
    expect(agent.text).toMatch(/^Here is how each change behaves:\n\n┌─+┬─+┐\n│ Behavior with +│ What the person sees +│\n├/);
    expect(agent.text).toContain('└');
    expect(agent.text).toMatch(/The sync runs every fifteen minutes\.$/);
  });

  it('parses it as a header row and body rows, a wrapped cell joined with spaces', () => {
    const parts = splitBoxTables(agent.text);
    expect(parts.map(p => p.kind)).toEqual(['text', 'table', 'text']);
    expect(parts[1]).toEqual({
      kind: 'table',
      head: ['Behavior with', 'What the person sees'],
      rows: [
        ['Only the catalog quantities change', 'Only the catalog quantities change, and the order totals are recomputed from them on the next sync; nothing already invoiced is touched, and a credit note is raised for any line whose price went down since the order was placed'],
        ['A new SKU is added', 'It shows up in the picker after the next refresh'],
        ['The supplier removes a SKU outright, mid-order', 'The line stays on open orders, marked discontinued, and cannot be added to new ones'],
      ],
    });
  });

  it('renders it as the markdown table, with no box glyphs left', () => {
    const out = html(agent.text);
    expect(out).toContain('<div class="md-table"><table><thead><tr><th>Behavior with</th><th>What the person sees</th></tr></thead><tbody>');
    expect(out).toContain('<td>A new SKU is added</td><td>It shows up in the picker after the next refresh</td>');
    expect(out).not.toMatch(/[┌│├└─]/);
    expect(out).toContain('<div>Here is how each change behaves:</div>');
  });

  it('reads a capture that starts mid-table as body rows with no header', () => {
    const lines = PANE.split('\n');
    const cut = lines.findIndex(l => l.includes('A new SKU')) - 1;   // the ├ rule above it
    const q = parsePane(lines.slice(cut).join('\n'), { provider: 'claude', role: 'agent' });
    expect(q.blocks[0]).toMatchObject({ kind: 'agent', partial: true });
    const parts = splitBoxTables(q.blocks[0].text);
    expect(parts[0]).toEqual({ kind: 'table', head: null, rows: [
      ['A new SKU is added', 'It shows up in the picker after the next refresh'],
      ['The supplier removes a SKU outright, mid-order', 'The line stays on open orders, marked discontinued, and cannot be added to new ones'],
    ] });
    const out = html(q.blocks[0].text);
    expect(out).toContain('<div class="md-table"><table><tbody><tr><td>A new SKU is added</td>');
    expect(out).not.toContain('<thead>');
  });

  it('takes a right border cut to � at the pane edge, or a table still printing', () => {
    expect(parseBoxTable(['┌───┬───�', '│ a │ b �', '├───┼───�', '│ c │ d'])).toEqual({ kind: 'table', head: ['a', 'b'], rows: [['c', 'd']] });
  });

  it('shows a malformed grid monospace with its rows intact, never as prose', () => {
    const text = 'Before\n┌───┬───┐\n│ a │ b │\n├───┼───┤\n│ c │ d │ e │\n└───┴───┘\nAfter';
    expect(splitBoxTables(text)[1]).toEqual({ kind: 'grid', text: '┌───┬───┐\n│ a │ b │\n├───┼───┤\n│ c │ d │ e │\n└───┴───┘' });
    const out = html(text);
    expect(out).toContain('<pre class="m-grid">┌───┬───┐\n│ a │ b │\n├───┼───┤\n│ c │ d │ e │\n└───┴───┘</pre>');
    expect(out).not.toContain('md-table');
    // A tree is box drawing too, and is not a table: monospace as well.
    expect(splitBoxTables('├── src\n└── docs')).toEqual([{ kind: 'grid', text: '├── src\n└── docs' }]);
  });

  it('reads a run of │ rows with no rule, or a one-column box, as a grid, not a table', () => {
    // A file tree's │ rail scrolled so no ├ is in view, and bar rows sharing a column count.
    expect(splitBoxTables('│   x\n│   y')).toEqual([{ kind: 'grid', text: '│   x\n│   y' }]);
    expect(splitBoxTables('│ a │ b │\n│ c │ d │')[0].kind).toBe('grid');
    // A boxed note is a frame with one column, not a table.
    expect(splitBoxTables('╭────────╮\n│ Note:  │\n│ more   │\n╰────────╯')[0].kind).toBe('grid');
    expect(html('│ one\n│ two')).toContain('<pre class="m-grid">│ one\n│ two</pre>');
  });

  it('leaves prose without box drawing as it was', () => {
    expect(html('Just text, | with a pipe')).toContain('<div class="m-block-text"><div>Just text, | with a pipe</div></div>');
  });
});
