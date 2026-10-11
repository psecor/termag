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
    usage: 'termag ssh-config [--install]\n\n'
      + 'Then `ssh termag-<box>`, scp, rsync and editor Remote-SSH reach every box you own.',
    options: { install: { type: 'boolean' } },
    maxArgs: 0,
  },
  'ssh-proxy': {
    summary: 'The ssh-config entry\'s ProxyCommand (run by ssh, not by hand)',
    usage: 'termag ssh-proxy termag-<box> <port>',
    maxArgs: 2,
  },
};
