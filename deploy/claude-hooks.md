# Adding termag as a Claude Code hook target

The proxy bot already has hooks configured. Add termag as a second POST target.

Edit `~/.claude/settings.json` on secorp.net:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "curl -s -X POST http://localhost:3040/termag/api/status -H 'Content-Type: application/json' -d '{\"session\":\"'$(tmux display-message -p '#S')'\",\"status\":\"working\"}' &"
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "curl -s -X POST http://localhost:3040/termag/api/status -H 'Content-Type: application/json' -d '{\"session\":\"'$(tmux display-message -p '#S')'\",\"status\":\"working\"}' &"
          }
        ]
      }
    ],
    "Notification": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "curl -s -X POST http://localhost:3040/termag/api/status -H 'Content-Type: application/json' -d '{\"session\":\"'$(tmux display-message -p '#S')'\",\"status\":\"waiting\"}' &"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "curl -s -X POST http://localhost:3040/termag/api/status -H 'Content-Type: application/json' -d '{\"session\":\"'$(tmux display-message -p '#S')'\",\"status\":\"idle\"}' &"
          }
        ]
      }
    ]
  }
}
```

Notes:
- Uses `tmux display-message -p '#S'` to get the current tmux session name automatically
- POSTs to localhost (no auth needed — restrict at Apache level if desired)
- The `&` backgrounds the curl so it never blocks Claude
- If the proxy bot hooks already exist, add these as additional entries in each array
