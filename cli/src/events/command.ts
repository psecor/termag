import { Api, type Box } from '../api.js';
import type { CommandSpec, ParsedArgs } from '../args.js';
import { bearerFor, session } from '../commands.js';
import type { Ctx } from '../context.js';
import { CliError, EXIT, type ExitCode } from '../errors.js';
import { untilSignal } from '../forward/command.js';
import { isMissingWs } from '../lazyWs.js';
import { EventTracker, describeEvent, parseFrame, type TermagEvent } from './model.js';

export const EVENTS_COMMANDS: Record<string, CommandSpec> = {
  events: {
    summary: 'Stream your boxes\' state changes and your agents\' status changes, until Ctrl-C',
    usage: 'termag events [--json]',
    details: 'First the current state, one line per box and per agent session, then one line per change.\n'
      + '--json prints each as a JSON object on its own line; cli/README.md, "Events", lists the fields.',
    maxArgs: 0,
  },
};

/** How often the box list is read while a box is going up or down, and otherwise. */
const SETTLING_POLL_MS = 5_000;
const IDLE_POLL_MS = 30_000;

/** The socket, and with it `ws`, loads only for `termag events` (forward/command.ts says why). */
export async function loadStatusSocket(): Promise<typeof import('./socket.js')> {
  try {
    return await import('./socket.js');
  } catch (err) {
    if (!isMissingWs(err)) throw err;
    throw new CliError('failed', 'termag events needs the `ws` package, which this install is missing (an interrupted reinstall?); run `termag update` or `cli/install.sh` in the termag checkout');
  }
}

/**
 * Read the box list now and then: every `settlingMs` while a box is in a
 * state that settles on its own, else every IDLE_POLL_MS, and at once on
 * `poke()`. A read that fails is retried on the socket's backoff schedule;
 * one refused for the credential ends the stream.
 */
function pollBoxes(o: {
  api: Api;
  tracker: EventTracker;
  emit: (events: TermagEvent[]) => void;
  settlingMs: number;
  backoffMs: readonly number[];
  notice: (line: string) => void;
  onFirstRead: () => void;
  onFatal: (err: CliError) => void;
}): { poke: () => void; stop: () => void } {
  let stopped = false;
  let poked = false;
  let wake: (() => void) | null = null;

  void (async () => {
    let failures = 0;
    let first = true;
    while (!stopped) {
      poked = false;
      let delay: number;
      try {
        const { boxes } = await o.api.request<{ boxes: Box[] }>('GET', '/boxes');
        if (stopped) return;
        o.emit(o.tracker.boxList(boxes, new Date().toISOString()));
        if (failures) o.notice('reading the box list again');
        failures = 0;
        if (first) { first = false; o.onFirstRead(); }
        delay = poked ? 0 : o.tracker.settling() ? o.settlingMs : IDLE_POLL_MS;
      } catch (err) {
        if (stopped) return;
        if (err instanceof CliError && err.code === 'auth_required') { o.onFatal(err); return; }
        if (!failures) o.notice(`can't read the box list (${err instanceof Error ? err.message : String(err)}); retrying`);
        failures++;
        delay = o.backoffMs[Math.min(failures, o.backoffMs.length - 1)];
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, delay);
        function done() { clearTimeout(timer); wake = null; resolve(); }
        wake = done;
      });
    }
  })();

  return {
    poke: () => { if (wake) wake(); else poked = true; },
    stop: () => { stopped = true; wake?.(); },
  };
}

/** Ctrl-C (or a SIGTERM or SIGHUP), or the reader of stdout going away, as `| head -1` does. */
function untilStopped(): Promise<void> {
  return Promise.race([untilSignal(), new Promise<void>((resolve) => { process.stdout.on('error', () => resolve()); })]);
}

export async function cmdEvents(ctx: Ctx, args: ParsedArgs): Promise<ExitCode> {
  const { openStatusSocket, statusSocketUrl, BACKOFF_MS } = await loadStatusSocket();
  const s = session(ctx, args);
  const token = bearerFor(ctx, s);
  const api = new Api({ host: s.target.host, token, fetch: ctx.fetch });
  const tracker = new EventTracker();
  const emit = (events: TermagEvent[]) => {
    for (const e of events) ctx.out(args.json ? JSON.stringify(e) : describeEvent(e));
  };
  const notice = (line: string) => ctx.err(`termag events: ${line}`);

  let fail!: (err: CliError) => void;
  const failed = new Promise<CliError>((resolve) => { fail = resolve; });
  let stopSocket = () => {};
  let down = false;

  const boxes = pollBoxes({
    api, tracker, emit, notice,
    settlingMs: ctx.pollIntervalMs ?? SETTLING_POLL_MS,
    backoffMs: BACKOFF_MS,
    onFatal: fail,
    // Boxes first, so the sessions' first events can name theirs.
    onFirstRead: () => {
      stopSocket = openStatusSocket({
        url: statusSocketUrl(s.target.host),
        token,
        onText: (text) => {
          const f = parseFrame(text);
          if (f?.kind === 'status') {
            const e = tracker.status(f, new Date().toISOString());
            if (e) emit([e]);
          } else if (f?.kind === 'boxes-changed') {
            boxes.poke();
          }
        },
        // Back after a drop: the replay that follows has the statuses that changed meanwhile, a read the boxes.
        onOpen: () => {
          if (!down) return;
          down = false;
          notice('connected again');
          boxes.poke();
        },
        onDown: (reason, retryInMs) => {
          if (!down) notice(`lost the status socket (${reason}); reconnecting${retryInMs ? ` in ${Math.ceil(retryInMs / 1000)} s` : ''}`);
          down = true;
        },
        onFatal: fail,
      }).stop;
    },
  });

  const outcome = await Promise.race([failed, (ctx.untilInterrupted ?? untilStopped)().then(() => null)]);
  boxes.stop();
  stopSocket();
  if (outcome) throw outcome;
  return EXIT.OK;
}

export const EVENTS_HANDLERS: Record<string, (ctx: Ctx, args: ParsedArgs) => Promise<ExitCode>> = {
  events: cmdEvents,
};
