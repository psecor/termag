'use strict';
// The agents a chat-runner turn can run (chat-runner.js starts the turn,
// chat-turn.js runs it), one entry each: what the runner and the turn wrapper
// ask of an engine, read from here instead of an `engine === 'pi'` at every
// turn. A new engine is an entry here, its launch in chat-runner.js
// (`headless`: its binary, argv, session file and history), and, when its
// stdout isn't Claude's stream-json, a normaliser that makes it so.
//
// claude: Claude Code (`claude -p`, stream-json), the default and what a turn,
//   state or meta from before engines is. Only it has live input, images,
//   MCP, model backends, telemetry, space memory and appended system prompts.
// pi: pi (`termag-pi-headless --headless -p --mode json`,
//   chat-pi-v1), its stream through pi-events.js. The runner names its
//   session; it leads its own process group, and every stop is SIGTERM to it
//   (the gotcha "A pi chat turn never loads the pi status extension, and is
//   stopped with SIGTERM to its process group").
// cursor: Cursor's agent CLI (`cursor-agent -p --output-format stream-json`,
//   chat-cursor-v1), its stream through cursor-events.js. Cursor names the
//   session (`--resume <id>` keeps it), and its own store is SQLite, so the
//   turn wrapper keeps the chat's transcript itself (runnerTranscript). Its
//   shell tools run under it, so it is stopped as pi is: SIGTERM to its group.
// devin: the Devin CLI's ACP server (`devin acp`, chat-devin-v1), which
//   devin-acp.js drives for the turn (its process is the turn's agent) and
//   devin-events.js reads. Devin names the session and session/load goes on
//   with it, but a load can fail and start a new one (resumeKeepsId false).
//   Its store is SQLite too (runnerTranscript), and it is stopped as Cursor is.
//
// Each entry:
//   label                  what messages call the agent ("pi exited 1")
//   claudeCode             it is Claude Code: everything above that only Claude has
//   liveInput, images      a live turn's stdin, and a prompt.jsonl with image blocks
//   sessionMadeBy          'engine' (the init line's session_id) or 'runner' (a uuid it passes in)
//   signals                { group, stop, interrupt }: whether the agent leads its own
//                          process group (spawned detached, signalled as a group), and
//                          the signal a stop and an interrupt send
//   stopReadsAsInterrupt   a stopped turn's own exit (143) reads as SIGINT downstream
//   canClear, canCompact   chat-reset and chat-compact
//   pagesHistory           chat-history says `more`, and chat-history-before pages
//   subagents, titles      Claude Code's subagent transcripts and session titles
//   paneResume             Open in full UI can type a resume of the session
//   createNormalizer       for a stream that isn't Claude's: () => { push(line) -> events[], end(exit) -> events[] }
//   rawLog                 the turn dir's file for that stream as the agent wrote it
//   runnerTranscript       the agent's own session store can't be read (SQLite): chat-turn.js writes the
//                          session's transcript, Claude-shaped, to <chats>/sessions/<engine>/<session>.jsonl
//   resumeKeepsId          a resumed turn always goes on in the session it was given; false: it may name a new one
//                          (a load that failed), so the session it was given goes to earlier, as an engine switch's does

const ENGINE_SPECS = Object.freeze({
  claude: Object.freeze({
    id: 'claude',
    label: 'Claude',
    claudeCode: true,
    liveInput: true,
    images: true,
    sessionMadeBy: 'engine',
    signals: Object.freeze({ group: false, stop: 'SIGTERM', interrupt: 'SIGINT' }),
    stopReadsAsInterrupt: false,
    canClear: true,
    canCompact: true,
    pagesHistory: true,
    subagents: true,
    titles: true,
    paneResume: true,
    createNormalizer: null,
    rawLog: null,
    runnerTranscript: false,
    resumeKeepsId: true,
  }),
  pi: Object.freeze({
    id: 'pi',
    label: 'pi',
    claudeCode: false,
    liveInput: false,
    images: false,
    sessionMadeBy: 'runner',
    signals: Object.freeze({ group: true, stop: 'SIGTERM', interrupt: 'SIGTERM' }),
    stopReadsAsInterrupt: true,
    canClear: false,
    canCompact: false,
    pagesHistory: false,
    subagents: false,
    titles: false,
    paneResume: false,
    createNormalizer: () => require('./pi-events').createPiNormalizer(),
    rawLog: 'pi-events.jsonl',
    runnerTranscript: false,
    resumeKeepsId: true,
  }),
  cursor: Object.freeze({
    id: 'cursor',
    label: 'Cursor',
    claudeCode: false,
    liveInput: false,
    images: false,
    sessionMadeBy: 'engine',
    signals: Object.freeze({ group: true, stop: 'SIGTERM', interrupt: 'SIGTERM' }),
    stopReadsAsInterrupt: true,
    canClear: false,
    canCompact: false,
    pagesHistory: false,
    subagents: false,
    titles: false,
    paneResume: false,
    createNormalizer: () => require('./cursor-events').createCursorNormalizer(),
    rawLog: 'cursor-events.jsonl',
    runnerTranscript: true,
    resumeKeepsId: true,
  }),
  devin: Object.freeze({
    id: 'devin',
    label: 'Devin',
    claudeCode: false,
    liveInput: false,
    images: false,
    sessionMadeBy: 'engine',
    signals: Object.freeze({ group: true, stop: 'SIGTERM', interrupt: 'SIGTERM' }),
    stopReadsAsInterrupt: true,
    canClear: false,
    canCompact: false,
    pagesHistory: false,
    subagents: false,
    titles: false,
    paneResume: false,
    createNormalizer: () => require('./devin-events').createDevinNormalizer(),
    rawLog: 'devin-events.jsonl',
    runnerTranscript: true,
    resumeKeepsId: false,
  }),
});

/** Every engine this runner can start, in the table's order (Claude first). */
const ENGINE_IDS = Object.freeze(Object.keys(ENGINE_SPECS));

function isEngineId(v) {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(ENGINE_SPECS, v);
}

/** An engine's entry. Anything else (none, an older record's, one this agent doesn't know) is Claude's. */
function engineSpec(id) {
  return isEngineId(id) ? ENGINE_SPECS[id] : ENGINE_SPECS.claude;
}

/** What a state file or turn meta records for its engine: nothing for Claude, the default an older record reads as. */
function engineTag(id) {
  return isEngineId(id) && id !== 'claude' ? { engine: id } : {};
}

module.exports = { ENGINE_SPECS, ENGINE_IDS, engineSpec, engineTag, isEngineId };
