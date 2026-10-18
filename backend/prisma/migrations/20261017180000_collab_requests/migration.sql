-- Slack collaboration, phase 1: requests a
-- person sends colleagues through the termag bot, and their replies.

-- CreateTable
CREATE TABLE "collab_requests" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "ask" TEXT NOT NULL,
    "context" JSONB NOT NULL DEFAULT '[]',
    "tried" TEXT,
    "helpWanted" TEXT,
    "evidence" TEXT,
    "links" JSONB NOT NULL DEFAULT '[]',
    "projectId" TEXT,
    "workstream" TEXT,
    "fromSession" TEXT,
    "fromRole" TEXT,
    "fromInstanceId" TEXT,
    "origin" TEXT NOT NULL DEFAULT 'agent',
    "toChannel" TEXT,
    "toPeople" JSONB NOT NULL DEFAULT '[]',
    "state" TEXT NOT NULL DEFAULT 'draft',
    "previewChannel" TEXT,
    "previewTs" TEXT,
    "slackChannel" TEXT,
    "slackTs" TEXT,
    "permalink" TEXT,
    "sentAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "resolvedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "collab_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "collab_responses" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "responderSlackId" TEXT NOT NULL,
    "responderName" TEXT,
    "text" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "slackTs" TEXT,
    "notifiedAt" TIMESTAMP(3),
    "nudgedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "collab_responses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "collab_requests_userId_createdAt_idx" ON "collab_requests"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "collab_requests_projectId_workstream_idx" ON "collab_requests"("projectId", "workstream");

-- CreateIndex
CREATE INDEX "collab_requests_slackChannel_slackTs_idx" ON "collab_requests"("slackChannel", "slackTs");

-- CreateIndex
CREATE UNIQUE INDEX "collab_responses_requestId_slackTs_key" ON "collab_responses"("requestId", "slackTs");

-- CreateIndex
CREATE INDEX "collab_responses_requestId_createdAt_idx" ON "collab_responses"("requestId", "createdAt");

-- CreateIndex
CREATE INDEX "collab_responses_nudgedAt_idx" ON "collab_responses"("nudgedAt");

-- AddForeignKey
ALTER TABLE "collab_requests" ADD CONSTRAINT "collab_requests_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collab_responses" ADD CONSTRAINT "collab_responses_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "collab_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
