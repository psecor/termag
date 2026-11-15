-- Feedback about termag from `termag feedback`. Additive only.

-- CreateTable
CREATE TABLE "feedback" (
    "id" TEXT NOT NULL,
    "reporterUserId" TEXT NOT NULL,
    "credential" TEXT NOT NULL,
    "boxId" TEXT,
    "projectId" TEXT,
    "workstream" TEXT,
    "threadId" TEXT,
    "agentProvider" TEXT,
    "agentModel" TEXT,
    "agentVersion" TEXT,
    "cliVersion" TEXT,
    "boxAgentCommit" TEXT,
    "boxAgentCapabilities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "body" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'other',
    "redacted" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL DEFAULT 'new',
    "seenAt" TIMESTAMP(3),
    "seenById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "feedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "feedback_status_createdAt_idx" ON "feedback"("status", "createdAt");

-- CreateIndex
CREATE INDEX "feedback_createdAt_idx" ON "feedback"("createdAt");

-- CreateIndex
CREATE INDEX "feedback_boxId_createdAt_idx" ON "feedback"("boxId", "createdAt");

-- CreateIndex
CREATE INDEX "feedback_reporterUserId_createdAt_idx" ON "feedback"("reporterUserId", "createdAt");
