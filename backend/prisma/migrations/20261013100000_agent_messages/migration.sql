-- Agent-to-agent asks: threads, messages, and the
-- bundle rows held until published. Reply text is never stored. Additive only.

-- CreateTable
CREATE TABLE "agent_threads" (
    "id" TEXT NOT NULL,
    "originUserId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "workstream" TEXT NOT NULL DEFAULT 'main',
    "instanceId" TEXT NOT NULL,
    "claudeSessionId" TEXT,
    "baseSha" TEXT,
    "repo" TEXT,
    "branch" TEXT,
    "prNumber" INTEGER,
    "prUrl" TEXT,
    "hopCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_threads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_messages" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "senderUserId" TEXT NOT NULL,
    "senderInstanceId" TEXT,
    "projectId" TEXT NOT NULL,
    "workstream" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "hop" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "error" TEXT,
    "promptBytes" INTEGER NOT NULL,
    "replyBytes" INTEGER,
    "numTurns" INTEGER,
    "publish" TEXT,
    "publishDetail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "resultAt" TIMESTAMP(3),
    "readAt" TIMESTAMP(3),

    CONSTRAINT "agent_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_bundles" (
    "messageId" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_bundles_pkey" PRIMARY KEY ("messageId")
);

-- CreateIndex
CREATE INDEX "agent_threads_originUserId_updatedAt_idx" ON "agent_threads"("originUserId", "updatedAt");

-- CreateIndex
CREATE INDEX "agent_threads_projectId_idx" ON "agent_threads"("projectId");

-- CreateIndex
CREATE INDEX "agent_messages_senderUserId_status_readAt_idx" ON "agent_messages"("senderUserId", "status", "readAt");

-- CreateIndex
CREATE INDEX "agent_messages_threadId_createdAt_idx" ON "agent_messages"("threadId", "createdAt");

-- CreateIndex
CREATE INDEX "agent_bundles_createdAt_idx" ON "agent_bundles"("createdAt");

-- AddForeignKey
ALTER TABLE "agent_threads" ADD CONSTRAINT "agent_threads_originUserId_fkey" FOREIGN KEY ("originUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_threads" ADD CONSTRAINT "agent_threads_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_messages" ADD CONSTRAINT "agent_messages_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "agent_threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_messages" ADD CONSTRAINT "agent_messages_senderUserId_fkey" FOREIGN KEY ("senderUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

