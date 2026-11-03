import type { Exec } from '../system.js';

/**
 * Who listens on a local TCP port, from `lsof -nP -iTCP:<p> -sTCP:LISTEN`
 * (macOS and Linux), e.g. `node (pid 4242, user alice)`. Null when lsof is
 * missing, fails, or can't see the holder (another user's process, without
 * root).
 */
export async function portHolder(exec: Exec | undefined, port: number): Promise<string | null> {
  if (!exec) return null;
  let result;
  try {
    result = await exec('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { timeoutMs: 5000 });
  } catch {
    return null;
  }
  if (result.code !== 0) return null;
  const holders = new Map<string, string>();
  for (const line of result.stdout.split('\n').slice(1)) {
    const [command, pid, user] = line.trim().split(/\s+/);
    if (!command || !/^\d+$/.test(pid ?? '')) continue;
    // lsof escapes odd bytes in names (\x20); keep them printable and short.
    const name = command.replace(/[^\x21-\x7e]/g, '?').slice(0, 40);
    holders.set(pid, `${name} (pid ${pid}${user ? `, user ${user}` : ''})`);
  }
  return holders.size ? [...holders.values()].join(', ') : null;
}
