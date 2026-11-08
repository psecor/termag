-- Preview links: the preview
-- audience core (audiences, grantees, viewers, events: services/previewAudience.ts),
-- and the link delivery on it (links, their name reservations, the landing-page
-- codes, viewer sessions, agent requests, box-made confirmations). New tables only, additive to main.

-- CreateTable
CREATE TABLE "preview_audiences" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "workstreamId" TEXT,
    "ownerId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "endReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "preview_audiences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "preview_audience_grantees" (
    "id" TEXT NOT NULL,
    "audienceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "preview_audience_grantees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "preview_audience_viewers" (
    "id" TEXT NOT NULL,
    "audienceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "firstOpenedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastOpenedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "preview_audience_viewers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "preview_audience_events" (
    "id" TEXT NOT NULL,
    "audienceId" TEXT NOT NULL,
    "actorId" TEXT,
    "kind" TEXT NOT NULL,
    "reason" TEXT,
    "deliveryKind" TEXT,
    "deliveryId" TEXT,
    "detail" JSONB,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "preview_audience_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "preview_links" (
    "id" TEXT NOT NULL,
    "audienceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    "linkTokenHash" TEXT,
    "hostMode" TEXT NOT NULL DEFAULT 'localhost',
    "requestId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "preview_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "preview_link_names" (
    "name" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "reservedUntil" TIMESTAMP(3) NOT NULL,
    "linkId" TEXT,

    CONSTRAINT "preview_link_names_pkey" PRIMARY KEY ("name")
);

-- CreateTable
CREATE TABLE "preview_link_codes" (
    "codeHash" TEXT NOT NULL,
    "linkId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "basis" TEXT NOT NULL,
    "tokenHash" TEXT,
    "sessionIdHash" TEXT,
    "next" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "preview_link_codes_pkey" PRIMARY KEY ("codeHash")
);

-- CreateTable
CREATE TABLE "preview_link_sessions" (
    "idHash" TEXT NOT NULL,
    "linkId" TEXT NOT NULL,
    "basis" TEXT NOT NULL,
    "tokenHash" TEXT,
    "userId" TEXT NOT NULL,
    "verifiedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "preview_link_sessions_pkey" PRIMARY KEY ("idHash")
);

-- CreateTable
CREATE TABLE "preview_link_confirmations" (
    "idHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "fromBoxId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "request" JSONB NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'pending',
    "failure" TEXT,
    "linkId" TEXT,
    "shareUrlSealed" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),

    CONSTRAINT "preview_link_confirmations_pkey" PRIMARY KEY ("idHash")
);

-- CreateTable
CREATE TABLE "preview_link_requests" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "workstreamId" TEXT,
    "boxId" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    "note" TEXT,
    "state" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),

    CONSTRAINT "preview_link_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "preview_audiences_projectId_idx" ON "preview_audiences"("projectId");

-- CreateIndex
CREATE INDEX "preview_audiences_workstreamId_idx" ON "preview_audiences"("workstreamId");

-- CreateIndex
CREATE INDEX "preview_audiences_ownerId_idx" ON "preview_audiences"("ownerId");

-- CreateIndex
CREATE INDEX "preview_audiences_expiresAt_idx" ON "preview_audiences"("expiresAt");

-- CreateIndex
CREATE INDEX "preview_audience_grantees_userId_idx" ON "preview_audience_grantees"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "preview_audience_grantees_audienceId_userId_key" ON "preview_audience_grantees"("audienceId", "userId");

-- CreateIndex
CREATE INDEX "preview_audience_viewers_userId_idx" ON "preview_audience_viewers"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "preview_audience_viewers_audienceId_userId_key" ON "preview_audience_viewers"("audienceId", "userId");

-- CreateIndex
CREATE INDEX "preview_audience_events_audienceId_at_idx" ON "preview_audience_events"("audienceId", "at");

-- CreateIndex
CREATE UNIQUE INDEX "preview_links_linkTokenHash_key" ON "preview_links"("linkTokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "preview_links_requestId_key" ON "preview_links"("requestId");

-- CreateIndex
CREATE INDEX "preview_links_name_idx" ON "preview_links"("name");

-- CreateIndex
CREATE INDEX "preview_links_audienceId_idx" ON "preview_links"("audienceId");

-- CreateIndex
CREATE UNIQUE INDEX "preview_link_names_linkId_key" ON "preview_link_names"("linkId");

-- CreateIndex
CREATE INDEX "preview_link_names_reservedUntil_idx" ON "preview_link_names"("reservedUntil");

-- CreateIndex
CREATE INDEX "preview_link_codes_linkId_idx" ON "preview_link_codes"("linkId");

-- CreateIndex
CREATE INDEX "preview_link_codes_expiresAt_idx" ON "preview_link_codes"("expiresAt");

-- CreateIndex
CREATE INDEX "preview_link_sessions_linkId_idx" ON "preview_link_sessions"("linkId");

-- CreateIndex
CREATE INDEX "preview_link_sessions_userId_idx" ON "preview_link_sessions"("userId");

-- CreateIndex
CREATE INDEX "preview_link_sessions_expiresAt_idx" ON "preview_link_sessions"("expiresAt");

-- CreateIndex
CREATE INDEX "preview_link_confirmations_userId_idx" ON "preview_link_confirmations"("userId");

-- CreateIndex
CREATE INDEX "preview_link_confirmations_expiresAt_idx" ON "preview_link_confirmations"("expiresAt");

-- CreateIndex
CREATE INDEX "preview_link_requests_projectId_state_idx" ON "preview_link_requests"("projectId", "state");

-- AddForeignKey
ALTER TABLE "preview_audiences" ADD CONSTRAINT "preview_audiences_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "preview_audiences" ADD CONSTRAINT "preview_audiences_workstreamId_fkey" FOREIGN KEY ("workstreamId") REFERENCES "workstreams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "preview_audiences" ADD CONSTRAINT "preview_audiences_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "preview_audience_grantees" ADD CONSTRAINT "preview_audience_grantees_audienceId_fkey" FOREIGN KEY ("audienceId") REFERENCES "preview_audiences"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "preview_audience_grantees" ADD CONSTRAINT "preview_audience_grantees_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "preview_audience_viewers" ADD CONSTRAINT "preview_audience_viewers_audienceId_fkey" FOREIGN KEY ("audienceId") REFERENCES "preview_audiences"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "preview_audience_viewers" ADD CONSTRAINT "preview_audience_viewers_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "preview_audience_events" ADD CONSTRAINT "preview_audience_events_audienceId_fkey" FOREIGN KEY ("audienceId") REFERENCES "preview_audiences"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "preview_links" ADD CONSTRAINT "preview_links_audienceId_fkey" FOREIGN KEY ("audienceId") REFERENCES "preview_audiences"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "preview_link_names" ADD CONSTRAINT "preview_link_names_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES "preview_links"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "preview_link_codes" ADD CONSTRAINT "preview_link_codes_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES "preview_links"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "preview_link_sessions" ADD CONSTRAINT "preview_link_sessions_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES "preview_links"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "preview_link_sessions" ADD CONSTRAINT "preview_link_sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "preview_link_confirmations" ADD CONSTRAINT "preview_link_confirmations_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "preview_link_confirmations" ADD CONSTRAINT "preview_link_confirmations_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "preview_link_requests" ADD CONSTRAINT "preview_link_requests_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

