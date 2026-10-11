/**
 * The host's Claude runner orchestrator (deploy/claude-runner-orchestrator.service)
 * follows the lease: a process that
 * starts draining stops it, so only the new host's runner takes sessions, and
 * a process that serves starts it if it is enabled. That covers taking the
 * lease back (failover, or a restarted backend, which no longer knows it
 * stopped the runner). A unit cloud-init left disabled (no environment key,
 * or a claude without the subcommand) stays off; starting a running one is a
 * no-op.
 *
 * Failures are logged, never thrown: while draining the spawn route already
 * answers 503, so a runner left running only wastes its retries.
 */
import { execFile } from 'child_process';
import { existsSync } from 'fs';

export const RUNNER_UNIT = 'claude-runner-orchestrator.service';
export const RUNNER_UNIT_PATH = `/etc/systemd/system/${RUNNER_UNIT}`;

export type RunnerUnitVerb = 'stop' | 'start';

/** The argv deploy/claude-runner-orchestrator.sudoers allows, word for word. */
export function runnerUnitArgv(verb: RunnerUnitVerb): string[] {
  return ['-n', '/usr/bin/systemctl', verb, RUNNER_UNIT];
}

export const sudoSystemctl = (verb: RunnerUnitVerb): Promise<void> =>
  new Promise((resolve, reject) => {
    execFile('sudo', runnerUnitArgv(verb), { timeout: 90_000 }, (err, _stdout, stderr) => {
      if (err) reject(new Error(String(stderr).trim() || err.message));
      else resolve();
    });
  });

export const unitIsEnabled = (): Promise<boolean> =>
  new Promise(resolve => {
    execFile('systemctl', ['is-enabled', RUNNER_UNIT], { timeout: 10_000 }, (err, stdout) => {
      resolve(!err && String(stdout).trim() === 'enabled');
    });
  });

export interface RunnerUnitOnLease {
  drain(): Promise<void>;
  serve(): Promise<void>;
}

/** Calls run one at a time, in order. */
export function runnerUnitOnLease(opts: {
  systemctl: (verb: RunnerUnitVerb) => Promise<void>;
  isEnabled: () => Promise<boolean>;
  log?: (msg: string) => void;
}): RunnerUnitOnLease {
  const log = opts.log ?? (msg => console.log(msg));
  let chain: Promise<void> = Promise.resolve();
  const enqueue = (fn: () => Promise<void>) => (chain = chain.then(fn));

  return {
    drain: () => enqueue(async () => {
      try {
        await opts.systemctl('stop');
        log(`[CLAUDE-RUNNER] stopped ${RUNNER_UNIT} (draining)`);
      } catch (err) {
        log(`[CLAUDE-RUNNER] could not stop ${RUNNER_UNIT}: ${(err as Error).message}; spawns answer 503 while draining`);
      }
    }),
    serve: () => enqueue(async () => {
      if (!(await opts.isEnabled())) return;
      try {
        await opts.systemctl('start');
        log(`[CLAUDE-RUNNER] ${RUNNER_UNIT} running (serving)`);
      } catch (err) {
        log(`[CLAUDE-RUNNER] could not start ${RUNNER_UNIT}: ${(err as Error).message}`);
      }
    }),
  };
}

/** Only on a host the orchestrator image baked the unit onto, and only with the lease on. */
export function runnerUnitControlFromEnv(leaseOn: boolean, unitExists = existsSync(RUNNER_UNIT_PATH)): RunnerUnitOnLease | null {
  return leaseOn && unitExists ? runnerUnitOnLease({ systemctl: sudoSystemctl, isEnabled: unitIsEnabled }) : null;
}
