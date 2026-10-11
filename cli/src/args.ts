import { parseArgs, type ParseArgsConfig } from 'node:util';
import { CONNECT_COMMANDS } from './connect/specs.js';
import { usage } from './errors.js';
import { LIFECYCLE_ALIASES, LIFECYCLE_COMMANDS } from './lifecycle.js';

type OptionSpec = NonNullable<ParseArgsConfig['options']>;

export interface CommandSpec {
  summary: string;
  usage: string;
  options?: OptionSpec;
  maxArgs: number;
  /** Everything after the command's first argument is left unparsed, in `ParsedArgs.passthrough` (ssh options). */
  passthrough?: boolean;
}

export const GLOBAL_OPTIONS: OptionSpec = {
  json: { type: 'boolean' },
  yes: { type: 'boolean' },
  host: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean' },
};

export const COMMANDS: Record<string, CommandSpec> = {
  tui: {
    summary: 'Open the terminal UI: your projects, live status, peek and attach',
    usage: 'termag tui [ls [filter]]',
    maxArgs: 8,
  },
  login: {
    summary: 'Sign this device in through the browser',
    usage: 'termag login [--device <name>]',
    options: { device: { type: 'string' } },
    maxArgs: 0,
  },
  logout: { summary: 'Sign this device out and revoke its token', usage: 'termag logout', maxArgs: 0 },
  whoami: { summary: 'Show the signed-in user and the orchestrator', usage: 'termag whoami', maxArgs: 0 },
  doctor: {
    summary: 'Check this machine\'s termag setup and offer to fix what is missing',
    usage: 'termag doctor [--yes]',
    maxArgs: 0,
  },
  'box list': { summary: 'List your boxes', usage: 'termag box list', maxArgs: 0 },
  'project list': { summary: 'List your projects as <box>/<project>', usage: 'termag project list', maxArgs: 0 },
  ...LIFECYCLE_COMMANDS,
  ...CONNECT_COMMANDS,
  update: {
    summary: 'Pull the termag checkout this CLI was installed from and reinstall it',
    usage: 'termag update [--no-pull]',
    options: { 'no-pull': { type: 'boolean' } },
    maxArgs: 0,
  },
};

const ALIASES: Record<string, string> = {
  'box ls': 'box list',
  'project ls': 'project list',
  ...LIFECYCLE_ALIASES,
};

const GROUPS = new Set(['box', 'project']);

export interface ParsedArgs {
  command: string | null;
  args: string[];
  json: boolean;
  yes: boolean;
  host?: string;
  help: boolean;
  version: boolean;
  options: Record<string, string | boolean | undefined>;
  passthrough?: string[];
}

function allOptions(): OptionSpec {
  const out: OptionSpec = { ...GLOBAL_OPTIONS };
  for (const spec of Object.values(COMMANDS)) Object.assign(out, spec.options ?? {});
  return out;
}

/** For a passthrough command, splits argv just after its first argument. */
function splitPassthrough(argv: string[], opts: OptionSpec): { head: string[]; tail?: string[] } {
  const takesValue = (token: string) => token.startsWith('--')
    ? opts[token.slice(2)]?.type === 'string'
    : Object.values(opts).some(o => o.short === token.at(-1) && o.type === 'string');
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--') break;
    if (token.startsWith('-') && token !== '-') {
      if (!token.includes('=') && takesValue(token)) i++;
      continue;
    }
    positionals.push(token);
    if (positionals.length === 2 && COMMANDS[positionals[0]]?.passthrough) {
      return { head: argv.slice(0, i + 1), tail: argv.slice(i + 1) };
    }
  }
  return { head: argv };
}

export function parseCommandLine(argv: string[]): ParsedArgs {
  const { head, tail } = splitPassthrough(argv, allOptions());
  let parsed;
  try {
    parsed = parseArgs({ args: head, options: allOptions(), allowPositionals: true, strict: true });
  } catch (err) {
    throw usage((err as Error).message.replace(/\. To specify a positional.*$/s, ''));
  }
  const { values, positionals } = parsed;
  const v = values as Record<string, string | boolean | undefined>;
  const base = {
    json: v.json === true,
    yes: v.yes === true,
    host: typeof v.host === 'string' ? v.host : undefined,
    help: v.help === true,
    version: v.version === true,
  };

  let command: string | null = null;
  let rest = positionals;
  if (positionals[0] === 'help') {
    return { ...base, help: true, command: resolveHelpTarget(positionals.slice(1)), args: [], options: {} };
  }
  if (positionals.length > 0) {
    const [first, second] = positionals;
    if (GROUPS.has(first)) {
      if (!second) {
        if (base.help) return { ...base, command: null, args: [], options: {} };
        throw usage(`\`termag ${first}\` needs a subcommand: ${subcommandsOf(first).join(', ')}`);
      }
      command = ALIASES[`${first} ${second}`] ?? `${first} ${second}`;
      rest = positionals.slice(2);
    } else {
      command = first;
      rest = positionals.slice(1);
    }
    if (!COMMANDS[command]) throw usage(`Unknown command \`${positionals.slice(0, GROUPS.has(first) ? 2 : 1).join(' ')}\`. Run \`termag --help\`.`);
  }

  const spec = command ? COMMANDS[command] : null;
  const options: Record<string, string | boolean | undefined> = {};
  for (const name of Object.keys(v)) {
    if (name in GLOBAL_OPTIONS) continue;
    if (!spec?.options || !(name in spec.options)) {
      throw usage(`\`--${name}\` is not an option of \`termag${command ? ' ' + command : ''}\``);
    }
    options[name] = v[name];
  }
  if (spec && rest.length > spec.maxArgs && !base.help) {
    throw usage(`Too many arguments. Usage: ${spec.usage}`);
  }
  return { ...base, command, args: rest, options, ...(tail ? { passthrough: tail } : {}) };
}

function resolveHelpTarget(words: string[]): string | null {
  if (words.length === 0) return null;
  const joined = words.slice(0, 2).join(' ');
  const name = ALIASES[joined] ?? (COMMANDS[joined] ? joined : COMMANDS[words[0]] ? words[0] : null);
  if (!name) throw usage(`No help for \`${words.join(' ')}\`. Run \`termag --help\`.`);
  return name;
}

function subcommandsOf(group: string): string[] {
  return Object.keys(COMMANDS).filter(c => c.startsWith(group + ' ')).map(c => c.slice(group.length + 1));
}

export function helpText(command: string | null): string {
  if (command) {
    const spec = COMMANDS[command];
    return `${spec.summary}.\n\nUsage: ${spec.usage}\n\n${GLOBAL_HELP}`;
  }
  const width = Math.max(...Object.keys(COMMANDS).map(c => c.length));
  const lines = Object.entries(COMMANDS).map(([name, spec]) => `  ${name.padEnd(width)}  ${spec.summary}`);
  return `termag: manage termag boxes and projects from the command line.\n\nCommands:\n${lines.join('\n')}\n\n${GLOBAL_HELP}`;
}

const GLOBAL_HELP = `Global flags:
  --json          Machine-readable output
  --yes           Skip confirmations
  --host <url>    Orchestrator to use (or TERMAG_URL). Default: the production orchestrator,
                  or this box's own orchestrator when run on a box
  -h, --help      Show help
  --version       Show the version

Exit codes: 0 ok, 1 failed, 2 usage error, 3 not found, 4 auth needed, 5 timeout.`;
