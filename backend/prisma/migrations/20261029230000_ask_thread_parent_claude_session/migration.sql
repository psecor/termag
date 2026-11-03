-- The Claude Code session that sent a thread's first ask (`termag ask` from
-- inside Claude Code, CLAUDE_CODE_SESSION_ID), which the thread's turns name
-- as their parent in telemetry (termag.ask.parent.session). Null on threads
-- from before, and from outside Claude Code. Additive only.

-- AlterTable
ALTER TABLE "agent_threads" ADD COLUMN     "parentClaudeSession" TEXT;
