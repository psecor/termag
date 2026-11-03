import type { CommandSpec } from '../args.js';

export const CONNECT_COMMANDS: Record<string, CommandSpec> = {
  ssh: {
    summary: 'Open a shell on a box or in a project\'s directory, or run a command there',
    usage: 'termag ssh <box>[/<project>] [<ssh options>] [-- <cmd>]\n\n'
      + 'termag flags go before <box>; everything after it goes to ssh. One <cmd> argument is a\n'
      + 'shell command line, as with ssh; several are words passed through intact.\n'
      + '  termag ssh devbox/my-project -- claude -p "fix the failing test"\n'
      + '  termag ssh devbox/my-project -N -L 3000:localhost:3000',
    passthrough: true,
    maxArgs: 1,
  },
  attach: {
    summary: 'Attach this terminal to a project\'s agent session (--ctrl: its ctrl shell)',
    usage: 'termag attach <box>/<project> [--ctrl]',
    options: { ctrl: { type: 'boolean' } },
    maxArgs: 1,
  },
  'ssh-config': {
    summary: 'Print, or with --install add, the `Host termag-*` entry for ~/.ssh/config',
    usage: 'termag ssh-config [--install] [--wake]\n\n'
      + 'Then `ssh termag-<box>`, scp, rsync and editor Remote-SSH reach every box you own, and\n'
      + '`ssh termag-<box>.<project>` (or `.ctrl`) attaches to a project\'s agent (or ctrl shell).\n'
      + 'Re-run it after adding a box or a project.\n'
      + 'With --wake, connecting to a stopped or hibernated box starts it first. An editor\n'
      + 'that reconnects on its own then keeps a parked box up, so it is off by default.',
    options: { install: { type: 'boolean' }, wake: { type: 'boolean' } },
    maxArgs: 0,
  },
  'ssh-proxy': {
    summary: 'The ssh-config entry\'s ProxyCommand (run by ssh, not by hand)',
    usage: 'termag ssh-proxy [--wake [--timeout <seconds>]] termag-<box> <port>\n\n'
      + '--wake starts a stopped or hibernated box (one still stopping or hibernating once it\n'
      + 'has), as `termag box start --wait` does, then connects. Progress goes to stderr.\n'
      + '--timeout bounds each wait (default 600).',
    options: { wake: { type: 'boolean' }, timeout: { type: 'string' } },
    maxArgs: 2,
  },
};
