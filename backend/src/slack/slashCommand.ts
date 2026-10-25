/**
 * `/t` parsing and help (deploy/setup.md §7, "Slack commands"). The parse is
 * pure; events.ts runs what it returns.
 *
 * A command word claims the text only in the forms it takes. Anything else is
 * an instruction like any other and is typed into the agent: `/t projects`
 * lists projects, `/t projects ls` types `projects ls`. A command word without
 * the argument it needs (`/t switch`) shows that command's help rather than
 * typing the word. `/t -- <text>` types the rest exactly as written.
 *
 * Command words match in any casing, since phones capitalise the first word
 * (`/t Projects`); their arguments (names) keep theirs.
 */
import { isHandoffCommand } from './handoffCommand';

export type LocalAction =
  | { action: 'list' }
  | { action: 'detach'; name: string }
  | { action: 'register'; name: string };

export type SlashCommand =
  /** `topic` null is the overview. */
  | { kind: 'help'; topic: HelpTopic | null }
  | { kind: 'local'; local: LocalAction }
  | { kind: 'create'; name: string }
  | { kind: 'projects' }
  /** `target` is `<project>[/<workstream>]`, split by the handler. */
  | { kind: 'switch'; target: string }
  | { kind: 'sessions' }
  | { kind: 'attach'; session: string }
  | { kind: 'handoff' }
  | { kind: 'ctrl'; text: string }
  /**
   * Type `text` into the target. `literal` (`/t -- …`) types it as written:
   * a leading `!` is kept and a first word naming a local session is text.
   */
  | { kind: 'send'; text: string; literal: boolean };

// iOS Smart Punctuation (on by default) turns a typed `--` into an em dash.
const LITERAL_MARKERS = ['--', '—'];

export function parseSlashCommand(raw: string): SlashCommand {
  const text = raw.trim();
  const words = text.split(/\s+/).filter(Boolean);
  const first = words[0]?.toLowerCase();
  const sub = words[1]?.toLowerCase();
  const rest = first ? text.slice(first.length).trim() : '';
  const send: SlashCommand = { kind: 'send', text, literal: false };

  if (first && LITERAL_MARKERS.includes(first)) return { kind: 'send', text: rest, literal: true };

  switch (first) {
    case 'help':
      if (words.length === 1) return { kind: 'help', topic: null };
      if (words.length === 2 && helpTopic(sub)) return { kind: 'help', topic: helpTopic(sub) };
      return send;
    case 'local':
      if (words.length === 1 || (words.length === 2 && (sub === 'ls' || sub === 'list'))) {
        return { kind: 'local', local: { action: 'list' } };
      }
      if (sub === 'detach') {
        if (words.length === 3) return { kind: 'local', local: { action: 'detach', name: words[2] } };
        if (words.length === 2) return { kind: 'help', topic: 'local' };
        return send;
      }
      return words.length === 2 ? { kind: 'local', local: { action: 'register', name: words[1] } } : send;
    case 'create':
      return oneArgument(words, 'create', name => ({ kind: 'create', name })) ?? send;
    case 'switch':
      return oneArgument(words, 'switch', target => ({ kind: 'switch', target })) ?? send;
    case 'attach':
      return oneArgument(words, 'attach', session => ({ kind: 'attach', session })) ?? send;
    case 'projects':
      return words.length === 1 ? { kind: 'projects' } : send;
    case 'ls':
    case 'sessions':
      return words.length === 1 ? { kind: 'sessions' } : send;
    case 'ctrl':
      return { kind: 'ctrl', text: rest };
    case 'handoff':
      return isHandoffCommand(text) ? { kind: 'handoff' } : send;
    default:
      return send;
  }
}

/** `<word> <one argument>`; the word alone is its help; more words are not this command (undefined). */
function oneArgument(words: string[], topic: HelpTopic, command: (arg: string) => SlashCommand): SlashCommand | undefined {
  if (words.length === 1) return { kind: 'help', topic };
  if (words.length === 2) return command(words[1]);
  return undefined;
}

// ── Help ──────────────────────────────────────────────────────

interface HelpEntry {
  /** One line in the overview. */
  line: string;
  /** `/t help <topic>`. */
  details: string;
  /** Listed only for the ids in ALLOWED_SLACK_USERS (access.ts). */
  operatorsOnly?: true;
}

const HELP = {
  type: {
    line: '`/t <text>` types into the agent and presses Enter; `/t` alone shows its pane',
    details: [
      '*Typing into the agent*',
      '• `/t` shows the agent\'s pane.',
      '• `/t <text>` types the text into the agent, presses Enter, then posts the pane and updates it until the output settles.',
      '• `/t !<keys>` types without pressing Enter, for menus: `/t !2` picks option 2.',
      '• `/t -- <text>` types the text exactly as written and presses Enter, for text that starts with a command word (`/t -- help`) or with `!` (`/t -- !ls` runs `ls` in Claude Code\'s bash mode). It goes wherever `/t <text>` goes.',
      '',
      'A command word counts only in the form `/t help` lists. Anything else is typed into the agent: `/t projects` lists projects, `/t projects ls` types `projects ls`.',
      'React to a posted pane to answer it: :one:–:five: press that number, :white_check_mark: types `y`, :x: types `n`, :leftwards_arrow_with_hook: presses Enter and :arrows_counterclockwise: refreshes. Only the person who ran the `/t` can.',
    ].join('\n'),
  },
  ctrl: {
    line: '`/t ctrl [<text>]` does the same in the ctrl pane',
    details: [
      '*`/t ctrl [<text>]`*',
      'The ctrl pane is the shell beside the agent. `/t ctrl` shows it; `/t ctrl <text>` types the text and presses Enter; `/t ctrl !<keys>` types without Enter.',
      'Everything after `ctrl` is typed as it is: `/t ctrl help` runs the shell\'s `help`.',
    ].join('\n'),
  },
  handoff: {
    line: '`/t handoff [clear|compact|restart] [agent]` has the agent write a handoff, then start fresh on it',
    details: [
      '*`/t handoff [clear|compact|restart] [agent]`*',
      'When its turn ends the agent writes a handoff. Then its context is cleared (the default) or compacted, or its pane restarts. Naming an agent restarts the pane on it: `/t handoff restart cursor`.',
      'Only the project\'s owner can hand it off. Any other text after `handoff` is typed into the agent.',
    ].join('\n'),
  },
  projects: {
    line: '`/t projects` lists your projects and workstreams',
    details: [
      '*`/t projects`*',
      'Lists the projects you own or were shared, with their workstreams. ✅ marks what `/t` drives outside a project channel.',
      'Anything after `projects` is typed into the agent: `/t projects ls` types `projects ls`.',
    ].join('\n'),
  },
  switch: {
    line: '`/t switch <project>[/<workstream>]` picks what `/t` drives outside a project channel',
    details: [
      '*`/t switch <project>[/<workstream>]`*',
      'Sets the project and workstream `/t` drives in DMs and other channels, then posts its agent\'s pane. It is remembered across termag restarts. A project channel always drives its own project, whatever you switched to.',
      'Examples: `/t switch web`, `/t switch web/fix-login`. More than one word after `switch` is typed into the agent.',
    ].join('\n'),
  },
  attach: {
    line: '`/t attach <session>` shows a tmux session by name and switches to its project',
    details: [
      '*`/t attach <session>`*',
      'Posts the pane of a tmux session by its name (`<user>-<project>-agent`, `<user>-<project>-<workstream>-ctrl`, …) and switches `/t` to its project and workstream.',
    ].join('\n'),
  },
  ls: {
    line: '`/t ls` lists the tmux sessions on your boxes',
    details: [
      '*`/t ls`* (or `/t sessions`)',
      'Lists the tmux sessions on each of your boxes that is up, by box, and on your per-user agent if you run one. Projects shared with you are on their owner\'s box: use `/t projects` for those.',
      'Anything after `ls` is typed into the agent: `/t ls -la` types `ls -la`.',
    ].join('\n'),
  },
  create: {
    line: '`/t create <name>` creates a project on the termag server (admins only)',
    details: [
      '*`/t create <name>`*',
      'Creates a project on the termag server, with its tmux sessions and a `#proj-<user>-<name>` channel, and switches to it. Only admins can: projects on a box are created in the termag web UI.',
      'The name is letters, digits, `-` and `_`. More than one word after `create` is typed into the agent.',
    ].join('\n'),
  },
  local: {
    line: '`/t local [ls|<name>|detach <name>]` relays a session from your Mac',
    details: [
      '*`/t local`*',
      '• `/t local` or `/t local ls` lists the local sessions.',
      '• `/t local <name>` registers one; the Mac daemon fills it in.',
      '• `/t local detach <name>` removes one.',
      '• `/t <name> <text>` types into a local session, and while one is active `/t <text>` (and `/t -- <text>`) goes to it until you `/t switch` or `/t attach`.',
      'Only the Slack ids in `ALLOWED_SLACK_USERS` can use local sessions.',
    ].join('\n'),
    operatorsOnly: true,
  },
  routing: {
    line: '',
    details: [
      '*Which project `/t` drives*',
      '1. In a project channel (`#proj-<user>-<project>`, or `#proj-<user>-<project>-<workstream>` for a workstream), that project.',
      '2. Anywhere else, the one you picked with `/t switch` or `/t attach`.',
      '3. With neither, your first project with an agent: your own, else one shared with you.',
      'You can drive the projects you own and the ones shared with you.',
    ].join('\n'),
  },
  help: {
    line: '`/t help [<command>]` shows this, or one command in detail',
    details: [
      '*`/t help [<command>]`*',
      '`/t help` lists the commands; `/t help <command>` explains one. `/t help routing` explains which project `/t` drives.',
      'Any other text after `help` is typed into the agent: `/t help me fix the login test` goes to the agent.',
    ].join('\n'),
  },
} satisfies Record<string, HelpEntry>;

export type HelpTopic = keyof typeof HELP;

const TOPICS = new Map<string, HelpTopic>([
  ...(Object.keys(HELP) as HelpTopic[]).map(t => [t, t] as const),
  ['sessions', 'ls'], ['send', 'type'], ['--', 'type'], ['!', 'type'],
]);

/** The help topic a word names: a command, `routing`, `type`, or an alias. */
export function helpTopic(word: string | undefined): HelpTopic | null {
  return (word && TOPICS.get(word.toLowerCase())) || null;
}

/** `/t help [topic]`. `unscoped` (ALLOWED_SLACK_USERS) also lists the operators' commands. */
export function slashHelp(topic: HelpTopic | null, opts: { unscoped: boolean }): string {
  if (topic) return HELP[topic].details;
  const entries = (Object.values(HELP) as HelpEntry[]).filter(e => e.line && (opts.unscoped || !e.operatorsOnly));
  return [
    '*termag `/t`* types into a project\'s agent and posts its pane back.',
    ...entries.map(e => `• ${e.line}`),
    '',
    'A command word counts only in the form above: `/t projects ls` types `projects ls` into the agent. `/t -- <text>` types the text as written.',
    '`/t help <command>` explains one. `/t help type` covers typing and reactions, `/t help routing` which project `/t` drives.',
  ].join('\n');
}
