# pi `--mode json` fixtures (for A2's event normaliser)

Captured 2026-10-26 on an ask box with pi 1.0.2, a model broker on 127.0.0.1:8787 and a live
SSO session. Every run was:

```
cd <scratch cwd> && TERMAG_PI_EXT=/nonexistent/… setsid deploy/termag-pi-headless -p --mode json [args] < brief.md > X.jsonl 2> X.stderr
```

(`TERMAG_PI_EXT` pointed at a missing file so the launcher loaded neither `termag-status.ts` nor `termag-otel.ts`. The
default model is `fireworks/glm-5.3-flash`, picked by the launcher.)

Scrubbing: each system message's `sections`/`content` is replaced by `<… elided>` (its shape is kept;
`toolsAdded` schemas are kept). `/home/termag` is replaced by `/home/USER`, and AWS key ids, JWTs, signed URLs,
12-digit account ids, e-mails and bearer tokens are regex-replaced (none were found). Nothing else changed:
the event order, ids and usage are verbatim.

| Fixture | Args / how | Exit | Wall s | Notes |
|---|---|---|---|---|
| `success.jsonl` | no tools | 0 | 1.5 | `session` → … → `agent_end` → `agent_settled`; `agent_end.messages` = [system, user, assistant] |
| `tool-use-space-put.jsonl` | `--session-id <fresh uuid>`; write, bash, `termag space put` | 0 | 3.8 | 3× `tool_execution_start/update/end`, `toolcall_end` inside `message_update.assistantMessageEvent`; ids `chatcmpl-tool-…` |
| `resumed-session-id.jsonl` | same `--session-id` as above | 0 | 1.6 | same `session` header (original timestamp); **`agent_end.messages` = only this run's [user, assistant]** — no system, no history |
| `resumed-continue.jsonl` | `--continue` in same cwd | 0 | 1.5 | resumed the same session id |
| `error-bad-model.jsonl` | `--model no-such-model` | **0** | 1.0 | stderr `Warning: Model "no-such-model" not found … Using custom model id.`; last assistant `stopReason:"error"`, `errorMessage:"403: {…model is not in the trusted launch catalog…}"`, zero usage; still ends `agent_end`, `agent_settled` |
| `error-sso-missing.jsonl` | `PI_AWS_PROFILE=bogus` (or `AWS_CONFIG_FILE=/nonexistent`) | **1** | 0.5 | **empty stdout**; stderr: `pi-headless: AWS SSO session for '<profile>' is missing or expired.` / `  run: aws sso login --profile <profile>` |
| `interrupted-sigint-tool.jsonl` | SIGINT to pi during `sleep 61` | **130** | 3.8 | stream stops after `tool_execution_update`; no `agent_end`/`agent_settled`; **the tool's `bash -c` survives (orphan)** |
| `interrupted-sigterm-tool.jsonl` | SIGTERM to pi during `sleep 61` | **143** | 3.8 | same stream end; tool child killed; session file gets a `toolResult` `isError:true` "Command exited with code 137" |
| `interrupted-sigint-generation.jsonl` | SIGINT mid text stream | 130 | – | ends on `message_update`; middle trimmed (`_fixture_note` line) |
| `resumed-after-sigint.jsonl` | `--session-id` of the SIGINT-tool session | 0 | 3.3 | resumes fine; the model then claimed the interrupted command "completed" (wrong) |
| `readonly-write-refused.jsonl` | `--tools read,grep,find,ls --no-skills --no-approve` | 0 | 7.5 | system `tools` lists only those 4; model used `ls`, replied `STATUS: blocked …`; no file written |
| `thinking-off.jsonl` | `--thinking off --no-session` | 0 | 1.5 | accepted; assistant content still had a short `thinking` block |
| `concurrent-1.jsonl` | one of 3 parallel runs, one broker | 0 | 6.6 | all 3 succeeded |
| `session-file-v3-tool-use.jsonl` | the **session file** (not stdout) of the tool-use + 2 resumes | – | – | v3: `session`, `model_change`, `thinking_level_change`, `message` (system/user/assistant/toolResult with `toolCallId`,`toolName`) |

Normaliser rules these support:
- Skip `message_start/end` with `role:"system"` (pi 1.0.2 emits the system prompt as a message).
- Result text = last `message_end` with role `assistant`, its `content[type=text]` joined. `STATUS:` survived in every
  run that finished.
- Failure = exit ≠ 0, or no `agent_settled`, or last assistant `stopReason === "error"` (JSON mode exits 0 on model/HTTP errors).
- Sum `usage` over the assistant `message_end`s of the run: `input/output/cacheRead/cacheWrite/reasoning/totalTokens`; `cost.total` is
  **0** on the broker (present, zero).
