import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GEN_UI_ACTIONS } from './action';
import { GEN_UI_COMPONENTS } from './catalog';
import { GEN_UI_REFERENCE_PLACEHOLDER, genUiHint, genUiSystemPrompt } from './prompt';

/**
 * The prompt as the orchestrator sends it (backend/src/services/chatGenUi.ts):
 * generated here, from the catalog, and checked in. After changing the catalog
 * or prompt.ts, write it again with
 *   UPDATE_GEN_UI_PROMPT=1 npx vitest run src/chat/genui/prompt.test.ts
 */
const GENERATED = join(__dirname, '../../../../backend/src/services/chatGenUiPrompt.generated.ts');

/** A string as a TypeScript template literal, one line per source line. */
const literal = (text: string) => `\`${text.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${')}\``;

/** The reference (the whole prompt) and the hint every turn carries, as the backend imports them. */
export function promptModule(prompt: string, hint: string): string {
  return [
    '// Generated from the generative UI catalog (frontend/src/chat/genui/prompt.ts,',
    '// catalog.ts) by frontend/src/chat/genui/prompt.test.ts, which fails while this',
    '// file is out of date. Do not edit it: change the catalog or prompt.ts, then run',
    '//   UPDATE_GEN_UI_PROMPT=1 npx vitest run src/chat/genui/prompt.test.ts',
    '// in frontend/.',
    `export const CHAT_GEN_UI_PROMPT = ${literal(prompt)};`,
    '',
    `/** Every turn's few hundred tokens; the box puts the reference's path at ${GEN_UI_REFERENCE_PLACEHOLDER}. */`,
    `export const CHAT_GEN_UI_HINT = ${literal(hint)};`,
    '',
  ].join('\n');
}

describe('the generative UI system prompt', () => {
  const prompt = genUiSystemPrompt();

  it('is what the orchestrator sends', () => {
    const want = promptModule(prompt, genUiHint());
    if (process.env.UPDATE_GEN_UI_PROMPT) writeFileSync(GENERATED, want);
    expect(existsSync(GENERATED) ? readFileSync(GENERATED, 'utf8') : '', 'run UPDATE_GEN_UI_PROMPT=1 npx vitest run src/chat/genui/prompt.test.ts').toBe(want);
  });

  it('describes every component and action in the catalog, and the answer format', () => {
    for (const name of GEN_UI_COMPONENTS) expect(prompt).toContain(`- ${name}: `);
    for (const action of GEN_UI_ACTIONS) expect(prompt).toContain(`- ${action}: `);
    expect(prompt).toContain('```spec');
    expect(prompt).toContain('```ui-action');
    expect(prompt).toMatch(/untrusted/);
  });

  it('teaches nothing the chat refuses: nested repeats or watchers', () => {
    expect(prompt).not.toMatch(/nested list|inner repeat|STATE WATCHERS/i);
    expect(prompt).not.toContain('"watch":{');
    expect(prompt).toContain('no repeat inside another repeat');
  });

  it('never tells the agent to invent data', () => {
    expect(prompt).not.toMatch(/sample data|professional-looking/i);
    expect(prompt).toMatch(/Never invent sample, placeholder or realistic-looking data/);
    const lines = prompt.split('\n');
    const rules = lines.slice(lines.lastIndexOf('RULES:')).filter(l => /^\d+\. /.test(l)).map(l => Number(l.split('.')[0]));
    expect(rules).toEqual(rules.map((_, i) => i + 1));
  });

  it('stays a prompt a turn can carry', () => {
    expect(prompt.length).toBeLessThan(48 * 1024);
  });
});

describe('the generative UI hint every turn carries', () => {
  const hint = genUiHint();

  it('stays a few hundred tokens', () => {
    // About four characters a token: under 800 tokens, the full reference being about 9k.
    expect(hint.length).toBeLessThan(3200);
    expect(genUiSystemPrompt().length).toBeGreaterThan(hint.length * 5);
  });

  it('says when to use UI, names every component, and sends the agent to the reference first', () => {
    expect(hint.startsWith('GENERATIVE UI (termag):\n')).toBe(true);
    expect(hint).toMatch(/When in doubt, use prose/);
    for (const name of GEN_UI_COMPONENTS) expect(hint).toMatch(new RegExp(`[ ,]${name}[,.]`));
    expect(hint.split(GEN_UI_REFERENCE_PLACEHOLDER)).toHaveLength(2);
    expect(hint).toMatch(new RegExp(`Read ${GEN_UI_REFERENCE_PLACEHOLDER.replace(/[{}]/g, '\\$&')}`));
  });

  it('keeps the two rules no turn may go without: real data only, and answers are untrusted', () => {
    expect(hint).toMatch(/Never invent data/);
    expect(hint).toMatch(/untrusted/);
    expect(hint).toContain('```ui-action');
  });
});

describe('an unchosen Select or RadioGroup', () => {
  it('is seeded with null, which the catalog draws, never an empty string, which it refuses', () => {
    const prompt = genUiSystemPrompt();
    for (const component of ['A dropdown to pick one option.', 'Pick one of a few options, all visible.']) {
      const line = prompt.split('\n').find(l => l.includes(component));
      expect(line, component).toContain('seed it with null (never an empty string) while nothing is chosen');
    }
  });
});
