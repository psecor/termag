const HOST_UNIX_USERNAME_PATTERN = /^[a-z_][a-z0-9_.-]{0,31}$/;

// Must match the reserved-name case in deploy/termag-host-setup.
const RESERVED_HOST_UNIX_USERNAMES = new Set([
  'root',
  'termag',
  'ubuntu',
  'ssm-user',
  'nobody',
  'admin',
  'sudo',
  'adm',
  'docker',
  'postgres',
  'www-data',
  'lxd',
  'sync',
  'daemon',
  'bin',
  'sys',
  'games',
  'man',
  'mail',
  'news',
  'backup',
]);

export function explainHostUnixUsername(name: string): string | null {
  if (!HOST_UNIX_USERNAME_PATTERN.test(name)) {
    return `Unix username "${name}" cannot be provisioned on this host (must be 1–32 characters, start with a letter or underscore, and use only lowercase letters, digits, dot, underscore, or hyphen).`;
  }

  if (
    RESERVED_HOST_UNIX_USERNAMES.has(name)
    || name.startsWith('systemd-')
    || name.startsWith('_')
  ) {
    return `Unix username "${name}" is reserved on this host and cannot be auto-provisioned. Use a box, or ask an admin to map your email to a different unix username.`;
  }

  return null;
}

export class HostUnixUsernameError extends Error {
  readonly status = 400;

  constructor(name: string) {
    super(explainHostUnixUsername(name) ?? `Unix username "${name}" cannot be provisioned on this host.`);
    this.name = 'HostUnixUsernameError';
  }
}
