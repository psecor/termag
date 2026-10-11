-- ClaudeRunnerSession: one row per Claude Code cloud session the spawn route
-- started on a box (order id, owner, box, slot, startedAt), completed by the
-- box's end-of-session report (endedAt, exitStatus, exitReason). Backs the
-- per-owner `ended ... after Ns` journal lines. Additive only.

-- CreateTable
CREATE TABLE "claude_runner_sessions" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "slot" INTEGER NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "exitStatus" INTEGER,
    "exitReason" TEXT,

    CONSTRAINT "claude_runner_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "claude_runner_sessions_orderId_key" ON "claude_runner_sessions"("orderId");

-- CreateIndex
CREATE INDEX "claude_runner_sessions_userId_startedAt_idx" ON "claude_runner_sessions"("userId", "startedAt");

-- CreateIndex
CREATE INDEX "claude_runner_sessions_instanceId_endedAt_idx" ON "claude_runner_sessions"("instanceId", "endedAt");

-- AddForeignKey
ALTER TABLE "claude_runner_sessions" ADD CONSTRAINT "claude_runner_sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claude_runner_sessions" ADD CONSTRAINT "claude_runner_sessions_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;

