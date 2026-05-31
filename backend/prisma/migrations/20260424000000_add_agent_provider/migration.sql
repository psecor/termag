CREATE TYPE "AgentProvider" AS ENUM ('claude', 'codex');

ALTER TABLE "users"
ADD COLUMN "defaultAgentProvider" "AgentProvider" NOT NULL DEFAULT 'codex';

ALTER TABLE "workflows"
ADD COLUMN "provider" "AgentProvider";

UPDATE "workflows"
SET "provider" = 'claude'
WHERE "type" = 'agent';
