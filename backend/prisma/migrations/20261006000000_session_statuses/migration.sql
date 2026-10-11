-- CreateTable
CREATE TABLE "session_statuses" (
    "instanceKey" TEXT NOT NULL,
    "session" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "workingStartedAt" TIMESTAMP(3),
    "provider" TEXT,
    "source" TEXT,
    "message" TEXT,
    "waitingReason" TEXT,
    "threadId" TEXT,
    "contextTokens" INTEGER,
    "rateLimited" TEXT,
    "milestone" JSONB,

    CONSTRAINT "session_statuses_pkey" PRIMARY KEY ("instanceKey","session")
);

-- CreateIndex
CREATE INDEX "session_statuses_updatedAt_idx" ON "session_statuses"("updatedAt");
