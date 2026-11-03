-- Bug reports from `termag bug report` and their triage history.
-- Additive only.

-- CreateTable
CREATE TABLE "bug_reports" (
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
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'medium',
    "area" TEXT NOT NULL DEFAULT 'other',
    "cliVersion" TEXT,
    "boxAgentCommit" TEXT,
    "boxAgentCapabilities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "boxImage" TEXT,
    "command" TEXT,
    "errorOutput" TEXT,
    "redacted" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL DEFAULT 'new',
    "duplicateOfId" TEXT,
    "linkUrl" TEXT,
    "triagedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bug_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bug_report_events" (
    "id" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "status" TEXT,
    "duplicateOfId" TEXT,
    "linkUrl" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bug_report_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "bug_reports_status_createdAt_idx" ON "bug_reports"("status", "createdAt");

-- CreateIndex
CREATE INDEX "bug_reports_boxId_createdAt_idx" ON "bug_reports"("boxId", "createdAt");

-- CreateIndex
CREATE INDEX "bug_reports_reporterUserId_createdAt_idx" ON "bug_reports"("reporterUserId", "createdAt");

-- CreateIndex
CREATE INDEX "bug_report_events_reportId_createdAt_idx" ON "bug_report_events"("reportId", "createdAt");

-- AddForeignKey
ALTER TABLE "bug_report_events" ADD CONSTRAINT "bug_report_events_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "bug_reports"("id") ON DELETE CASCADE ON UPDATE CASCADE;
