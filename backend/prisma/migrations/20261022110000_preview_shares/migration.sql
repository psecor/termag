-- CreateTable
CREATE TABLE "preview_shares" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "workstreamId" TEXT,
    "ownerId" TEXT NOT NULL,
    "audience" TEXT NOT NULL,
    "granteeId" TEXT,
    "linkTokenHash" TEXT,
    "originRecipe" JSONB NOT NULL,
    "prRepo" TEXT,
    "prNumber" INTEGER,
    "prCommentId" TEXT,
    "wakeAllowed" BOOLEAN NOT NULL DEFAULT false,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "activeLinkKey" TEXT,
    "endedReason" TEXT,
    "lastOpenedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "preview_shares_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "preview_share_viewers" (
    "id" TEXT NOT NULL,
    "shareId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "firstOpenedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastOpenedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "preview_share_viewers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "preview_share_events" (
    "id" TEXT NOT NULL,
    "shareId" TEXT NOT NULL,
    "actorId" TEXT,
    "kind" TEXT NOT NULL,
    "reason" TEXT,
    "detail" JSONB,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "preview_share_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "preview_share_settings" (
    "projectId" TEXT NOT NULL,
    "prLinksEnabled" BOOLEAN NOT NULL DEFAULT false,
    "originRecipe" JSONB,
    "reviewerAccountHint" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "preview_share_settings_pkey" PRIMARY KEY ("projectId")
);

-- CreateIndex
CREATE UNIQUE INDEX "preview_shares_linkTokenHash_key" ON "preview_shares"("linkTokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "preview_shares_activeLinkKey_key" ON "preview_shares"("activeLinkKey");

-- CreateIndex
CREATE INDEX "preview_shares_granteeId_idx" ON "preview_shares"("granteeId");

-- CreateIndex
CREATE INDEX "preview_shares_projectId_idx" ON "preview_shares"("projectId");

-- CreateIndex
CREATE INDEX "preview_shares_workstreamId_idx" ON "preview_shares"("workstreamId");

-- CreateIndex
CREATE INDEX "preview_share_viewers_userId_idx" ON "preview_share_viewers"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "preview_share_viewers_shareId_userId_key" ON "preview_share_viewers"("shareId", "userId");

-- CreateIndex
CREATE INDEX "preview_share_events_shareId_at_idx" ON "preview_share_events"("shareId", "at");

-- AddForeignKey
ALTER TABLE "preview_shares" ADD CONSTRAINT "preview_shares_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "preview_shares" ADD CONSTRAINT "preview_shares_workstreamId_fkey" FOREIGN KEY ("workstreamId") REFERENCES "workstreams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "preview_shares" ADD CONSTRAINT "preview_shares_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "preview_shares" ADD CONSTRAINT "preview_shares_granteeId_fkey" FOREIGN KEY ("granteeId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "preview_share_viewers" ADD CONSTRAINT "preview_share_viewers_shareId_fkey" FOREIGN KEY ("shareId") REFERENCES "preview_shares"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "preview_share_viewers" ADD CONSTRAINT "preview_share_viewers_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "preview_share_events" ADD CONSTRAINT "preview_share_events_shareId_fkey" FOREIGN KEY ("shareId") REFERENCES "preview_shares"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "preview_share_settings" ADD CONSTRAINT "preview_share_settings_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

