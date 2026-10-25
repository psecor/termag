-- The draft PRs an ask thread opened, one per branch its runs sent.
-- Additive only: a process from
-- before it keeps reading agent_threads.prNumber / prUrl, which still hold the
-- thread's own PR.

-- CreateTable
CREATE TABLE "agent_thread_prs" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "branch" TEXT NOT NULL,
    "prNumber" INTEGER NOT NULL,
    "prUrl" TEXT NOT NULL,
    "headSha" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_thread_prs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "agent_thread_prs_threadId_key_key" ON "agent_thread_prs"("threadId", "key");

-- AddForeignKey
ALTER TABLE "agent_thread_prs" ADD CONSTRAINT "agent_thread_prs_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "agent_threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
