-- Chats continued on a new box, and each session's last git state. Additive only.

-- AlterTable
ALTER TABLE "chat_transcripts" ADD COLUMN "gitState" JSONB,
ADD COLUMN "gitStateAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "chat_resumes" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "workstreamId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "fromInstanceId" TEXT NOT NULL,
    "toInstanceId" TEXT NOT NULL,
    "gitState" JSONB,
    "lostWorkstreams" JSONB,
    "credentialsReadyAt" TIMESTAMP(3),
    "restoredAt" TIMESTAMP(3),
    "noticeTurnId" TEXT,
    "noticeSentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_resumes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "chat_resumes_workstreamId_toInstanceId_key" ON "chat_resumes"("workstreamId", "toInstanceId");

-- CreateIndex
CREATE INDEX "chat_resumes_toInstanceId_idx" ON "chat_resumes"("toInstanceId");

-- AddForeignKey
ALTER TABLE "chat_resumes" ADD CONSTRAINT "chat_resumes_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_resumes" ADD CONSTRAINT "chat_resumes_workstreamId_fkey" FOREIGN KEY ("workstreamId") REFERENCES "workstreams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "chat_continue_locks" (
    "projectId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_continue_locks_pkey" PRIMARY KEY ("projectId")
);

-- AddForeignKey
ALTER TABLE "chat_continue_locks" ADD CONSTRAINT "chat_continue_locks_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "chat_held_messages" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "workstreamId" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "model" TEXT,
    "backend" TEXT,
    "effort" TEXT,
    "claimedAt" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_held_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "chat_held_messages_workstreamId_createdAt_idx" ON "chat_held_messages"("workstreamId", "createdAt");

-- AddForeignKey
ALTER TABLE "chat_held_messages" ADD CONSTRAINT "chat_held_messages_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_held_messages" ADD CONSTRAINT "chat_held_messages_workstreamId_fkey" FOREIGN KEY ("workstreamId") REFERENCES "workstreams"("id") ON DELETE CASCADE ON UPDATE CASCADE;
