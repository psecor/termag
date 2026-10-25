import type { Register, Timer } from 'claude-code'

// Rewritten by `termag-credentials apply|remove mcp` after it changes
// ~/.claude.json. termag-reconcile
// fills in the absolute path when it installs this file; a mod has no home
// directory of its own to resolve.
const VERSION_FILE = '@TERMAG_MCP_VERSION_FILE@'
const POLL_MS = 2000

// What Claude Code answers /reload-plugins with where it refuses it: a session
// without a person at the prompt, unless the command came in on its own stdin.
const REFUSED = /isn't available/

export const register: Register = on => {
  let poll: Timer | null = null
  on('session.start', async ($, e, next) => {
    poll?.cancel()
    poll = null
    // `claude -p` and SDK sessions (the chat runner, termag ask) refuse a
    // plugin's /reload-plugins and echo the refusal into the transcript. They
    // need none: each chat turn is a new `claude -p --resume` process, which
    // reads ~/.claude.json's mcpServers at start, and a live turn that stays
    // up gets a reload_plugins control request on its stdin from
    // agent/chat-turn.js. Claude Code itself never reloads mcpServers when
    // ~/.claude.json changes, in any kind of session.
    if (!e.isInteractive) return next(e)
    const read = async () => String((await $.fs.read(VERSION_FILE).catch(() => '')) ?? '').trim()
    let seen = await read()
    let last = seen
    let refused = false
    // Polled rather than read on turn.complete: $.command.run rejects inside a
    // hook its turn awaits, and the engine queues the reload until the session
    // is idle anyway. One save can rewrite the file several times (a delivery
    // per change, an apply after a remove), so a change reloads once the file
    // has held still for a whole poll.
    poll = $.clock.every(POLL_MS, async () => {
      if (refused) return
      const now = await read()
      if (now !== last) { last = now; return }
      if (now === seen) return
      seen = now
      try {
        const { text } = await $.command.run({ command: 'reload-plugins' })
        // This session cannot reload at all: stop asking.
        if (text && REFUSED.test(text)) { refused = true; poll?.cancel() }
      } catch {
        // Refused (a host limit, past a Stop): the next change tries again,
        // this one is not retried.
      }
    })
    return next(e)
  })
}
