-- Admin interface, phase 0.
--
-- users.role / adminSource: who may reach /api/admin and /mcp/admin. Seeded at
-- startup from ADMIN_USERS (adminSource 'env') or granted by another admin
-- (adminSource 'grant'). Everyone existing stays a member.
ALTER TABLE "users" ADD COLUMN "role" TEXT NOT NULL DEFAULT 'member';
ALTER TABLE "users" ADD COLUMN "adminSource" TEXT;
-- users.lastSeenAt: bumped by requireAuth at most once per 5 minutes. No
-- backfill; null means "not seen since this column landed".
ALTER TABLE "users" ADD COLUMN "lastSeenAt" TIMESTAMP(3);

-- agent_tokens.scope: 'agent' (every existing row) | 'admin' | 'client'.
-- /ws/agent rejects anything but 'agent' so an admin token cannot evict a
-- real agent. expiresAt is null for agent tokens, 90 days by default for admin.
ALTER TABLE "agent_tokens" ADD COLUMN "scope" TEXT NOT NULL DEFAULT 'agent';
ALTER TABLE "agent_tokens" ADD COLUMN "expiresAt" TIMESTAMP(3);

-- Audit trail for every admin REST request and MCP tool call, reads included.
CREATE TABLE "admin_audit_log" (
    "id" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorId" TEXT NOT NULL,
    "tokenId" TEXT,
    "surface" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "args" JSONB,
    "outcome" TEXT NOT NULL,
    "status" INTEGER,

    CONSTRAINT "admin_audit_log_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "admin_audit_log_at_idx" ON "admin_audit_log"("at");
CREATE INDEX "admin_audit_log_actorId_at_idx" ON "admin_audit_log"("actorId", "at");
