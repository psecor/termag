-- Simple-UI New session's "Act as an orchestrator": the chat's turns are told
-- to use the agent-orchestrator skill (agent/chat-runner.js). Additive only.

-- AlterTable
ALTER TABLE "projects" ADD COLUMN     "chatOrchestrator" BOOLEAN NOT NULL DEFAULT false;
