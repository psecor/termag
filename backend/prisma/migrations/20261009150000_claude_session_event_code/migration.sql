-- the refusal's stable code on a session event (`queued`,
-- `agent-failed`), beside the sentence `detail` keeps. Additive, nullable:
-- rows from before carry none, and a reader falls back to the text.
ALTER TABLE "claude_session_events" ADD COLUMN "code" TEXT;
