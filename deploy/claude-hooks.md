# Claude Code Hooks for termag

Hooks let termag track agent status (working/waiting/idle) in real time.
Add these to `~/.claude/settings.json` on the server.

Each hook fires a POST to `http://localhost:3040/termag/api/status`.

## Hook configuration

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "SESSION=$(tmux display-message -p '#S' 2>/dev/null); [ -n \"$SESSION\" ] && curl -sf -X POST http://localhost:3040/termag/api/status -H 'Content-Type: application/json' -d \"{\\\"session\\\":\\\"$SESSION\\\",\\\"status\\\":\\\"working\\\"}\" >/dev/null 2>&1 &"
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": ".*",
        "hooks": [
          {
            "type": "command",
            "command": "SESSION=$(tmux display-message -p '#S' 2>/dev/null); [ -n \"$SESSION\" ] && curl -sf -X POST http://localhost:3040/termag/api/status -H 'Content-Type: application/json' -d \"{\\\"session\\\":\\\"$SESSION\\\",\\\"status\\\":\\\"working\\\"}\" >/dev/null 2>&1 &"
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": ".*",
        "hooks": [
          {
            "type": "command",
            "command": "SESSION=$(tmux display-message -p '#S' 2>/dev/null); [ -n \"$SESSION\" ] && curl -sf -X POST http://localhost:3040/termag/api/status -H 'Content-Type: application/json' -d \"{\\\"session\\\":\\\"$SESSION\\\",\\\"status\\\":\\\"working\\\"}\" >/dev/null 2>&1 &"
          }
        ]
      }
    ],
    "Notification": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "INPUT=$(cat); SESSION=$(tmux display-message -p '#S' 2>/dev/null); export SESSION; PAYLOAD=$(printf '%s' \"$INPUT\" | python3 -c \"import sys,json,os; d=json.load(sys.stdin); ntype=d.get('notification_type','unknown'); msg=d.get('message','')[:200]; status='idle' if ntype=='idle_prompt' else 'waiting'; print(json.dumps({'session':os.environ.get('SESSION',''),'status':status,'notify':True,'message':msg}))\" 2>/dev/null); [ -n \"$SESSION\" ] && [ -n \"$PAYLOAD\" ] && curl -sf -X POST http://localhost:3040/termag/api/status -H 'Content-Type: application/json' -d \"$PAYLOAD\" >/dev/null 2>&1 &"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "SESSION=$(tmux display-message -p '#S' 2>/dev/null); [ -n \"$SESSION\" ] && curl -sf -X POST http://localhost:3040/termag/api/status -H 'Content-Type: application/json' -d \"{\\\"session\\\":\\\"$SESSION\\\",\\\"status\\\":\\\"idle\\\"}\" >/dev/null 2>&1 &"
          }
        ]
      }
    ]
  }
}
```

## How it works

- `UserPromptSubmit`, `PreToolUse`, `PostToolUse` all post `status: "working"` (green light)
- `Notification` parses the hook input JSON to determine status:
  - `idle_prompt` -> `status: "idle"` (agent finished, no more work)
  - Everything else -> `status: "waiting"` (yellow light, needs input)
  - Sets `notify: true` so termag sends a Slack notification with the pane content
- `Stop` posts `status: "idle"` (red light)
- Uses `tmux display-message -p '#S'` to auto-detect the session name
- All curls are backgrounded with `&` so they never block Claude

## Slack notifications

When `notify: true` is set (Notification hook only), termag will:
1. Capture the tmux pane content
2. Post it to the Slack channel associated with that session (set via `/t` command)
3. Add emoji reaction hints if numbered prompts are detected (e.g. "1. Allow once")
4. You can respond by reacting with :one:, :two:, etc. to send that keystroke

Notification targets persist across service restarts (stored in the database).

## LTS hooks (optional)

If also running the LTS relay for remote Mac terminal capture, add a parallel
set of hooks posting to `http://localhost:3040/lts/status` with an
`Authorization: Bearer $SECRET` header. See the LTS section of setup.md.
