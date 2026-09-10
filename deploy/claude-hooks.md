# Claude Code Hooks for termag

Hooks let termag track agent status (working / waiting / idle) in real time, and
are what trigger the needs-input Slack notification.

Each hook shells out to **`termag-status`** (`deploy/termag-status`), which
resolves the server endpoint from the per-user agent's own `termag_url` and POSTs
to `<server>/termag/api/status`.

AMI-provisioned boxes get both files automatically via `packer/scripts/setup.sh` —
`deploy/claude-settings.json` lands at `~/.claude/settings.json` and
`termag-status` at `~/.local/bin/termag-status`. For a non-baked install:

```bash
install -m 755 deploy/termag-status ~/.local/bin/termag-status
mkdir -p ~/.claude && cp deploy/claude-settings.json ~/.claude/settings.json
```

`deploy/claude-settings.json` is the canonical hook config; the snippet below is
reproduced from it, so keep them in sync.

## Why not POST to localhost directly

Earlier versions inlined `curl http://localhost:3040/termag/api/status` in every
hook. That is only correct when the termag server runs on the same host as the
agent. On a provisioned box the server is elsewhere, so every POST failed —
**silently**, because the hooks background their curl and discard all output. The
symptom is status lights that never leave grey and needs-input notifications that
never arrive, with nothing in any log explaining why.

`agent/agent.js` already solved this for its own posts (`getStatusEndpoint()`);
`termag-status` applies the same derivation to the hooks:

| `termag_url` | endpoint |
|---|---|
| `ws://localhost:3040/termag/ws/agent` | `http://localhost:3040/termag/api/status` |
| `ws://ip-10-0-0-1.ec2.internal:3040/termag/ws/agent` | `http://ip-10-0-0-1.ec2.internal:3040/termag/api/status` |
| `wss://termag.example.com/termag/ws/agent` | `https://termag.example.com/termag/api/status` |

Co-located boxes keep working unchanged — they are just the case where the derived
host happens to be localhost.

## Hook configuration

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [ { "type": "command", "command": "\"$HOME/.local/bin/termag-status\" working >/dev/null 2>&1 &" } ] }
    ],
    "PreToolUse": [
      { "matcher": ".*", "hooks": [ { "type": "command", "command": "\"$HOME/.local/bin/termag-status\" working >/dev/null 2>&1 &" } ] }
    ],
    "PostToolUse": [
      { "matcher": ".*", "hooks": [ { "type": "command", "command": "\"$HOME/.local/bin/termag-status\" working >/dev/null 2>&1 &" } ] }
    ],
    "Notification": [
      { "hooks": [ { "type": "command", "command": "INPUT=$(cat); printf '%s' \"$INPUT\" | \"$HOME/.local/bin/termag-status\" notification >/dev/null 2>&1 &" } ] }
    ],
    "Stop": [
      { "hooks": [ { "type": "command", "command": "\"$HOME/.local/bin/termag-status\" idle >/dev/null 2>&1 &" } ] }
    ]
  }
}
```

## How it works

- `UserPromptSubmit`, `PreToolUse`, `PostToolUse` post `status: "working"` (green)
- `Notification` reads the hook JSON on stdin: `idle_prompt` -> `idle`, anything
  else -> `waiting` (yellow), with `notify: true` so termag posts the captured
  pane to Slack
- `Stop` posts `status: "idle"` (red)
- The tmux session name comes from `tmux display-message -p '#S'`; no session
  means no context, and the hook exits without posting

Two details are load-bearing:

1. **The trailing `&`.** Without it every tool use blocks on the POST and feels
   visibly slower. Don't remove it.
2. **`Notification` reads stdin in the foreground** (`INPUT=$(cat)`) and
   backgrounds only the pipe. Backgrounding the read races Claude Code closing
   the pipe and the payload is intermittently lost.

`termag-status` adds `curl -m 5` so an unreachable server cannot leave hook
processes accumulating.

## Verifying

```bash
# which endpoint will the hooks use?
~/.local/bin/termag-status --print-endpoint

# end-to-end: set a sentinel, make one tool call in Claude Code, read it back
ENDPOINT=$(~/.local/bin/termag-status --print-endpoint)
SESSION=$(tmux display-message -p '#S')
curl -sS -X POST "$ENDPOINT" -H 'Content-Type: application/json' \
  -d "{\"session\":\"$SESSION\",\"status\":\"not_running\"}"
# ... run any tool, then:
curl -sS "$ENDPOINT/$SESSION"     # expect status: working
```

A session the server has never heard from reports `not_running`.

Endpoint resolution is covered by `deploy/termag-status.test.sh`
(`sh deploy/termag-status.test.sh`) — no network, tmux or server required.

## Troubleshooting

| Symptom | Check |
|---|---|
| Status lights stay grey | `termag-status --print-endpoint`, then curl that server's `/termag/health` |
| Endpoint is `127.0.0.1:3040` on a remote box | the agent config wasn't found — check `~/src/termag/agent/agent.config.json`, or set `TERMAG_AGENT_CONFIG` |
| `Notification` never fires | `TERMAG_STATUS_DEBUG=1`, then inspect `~/.cache/termag-status/last-notification.json` |
| Stale `waiting` | expected — `agent/agent.js` sweeps these back to reality |

## LTS hooks (optional)

If also running the LTS relay for remote Mac terminal capture, add a parallel set
of hooks posting to `<server>/lts/status` with an `Authorization: Bearer $SECRET`
header. See the LTS section of setup.md.
