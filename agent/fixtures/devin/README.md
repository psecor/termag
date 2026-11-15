# Devin fixtures

`3000.12.57/acp.json`: Devin CLI 3000.12.57's own ACP answers, recorded on macOS (arm64) signed out, with
`DEVIN_SESSIONS_DIR` and HOME in scratch folders: initialize, session/new (its modes), set_mode to ask, a prompt
refused for the missing sign-in, a `/bypass` prompt switching the mode, session/load and its replay, and a load of
a session that isn't there. `devin-acp.test.js` replays them through a stand-in `devin acp`.

`spec/`: what devin-acp.js writes for a turn (its own `termag` lines and Devin's session/update notifications),
**built by hand from the ACP v1 spec and termag-desktop's Devin quirks, not recorded**: a turn's own updates
(thoughts, messages, tool calls, plans) need a signed-in Devin. Record real ones from a box and replace these.
