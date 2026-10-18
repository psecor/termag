-- CreateTable
CREATE TABLE "spaces" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readOnlyAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "usedBytes" BIGINT NOT NULL DEFAULT 0,
    "quotaBytes" BIGINT NOT NULL DEFAULT 107374182400,

    CONSTRAINT "spaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "space_members" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "addedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "space_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "space_boxes" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "addedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "space_boxes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "space_invites" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "addedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "space_invites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "space_events" (
    "id" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "spaceId" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "actorInstanceId" TEXT,
    "via" TEXT,
    "action" TEXT NOT NULL,
    "path" TEXT,
    "bytes" BIGINT,

    CONSTRAINT "space_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "spaces_name_key" ON "spaces"("name");

-- CreateIndex
CREATE INDEX "space_members_userId_idx" ON "space_members"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "space_members_spaceId_userId_key" ON "space_members"("spaceId", "userId");

-- CreateIndex
CREATE INDEX "space_boxes_instanceId_idx" ON "space_boxes"("instanceId");

-- CreateIndex
CREATE UNIQUE INDEX "space_boxes_spaceId_instanceId_key" ON "space_boxes"("spaceId", "instanceId");

-- CreateIndex
CREATE INDEX "space_invites_email_idx" ON "space_invites"("email");

-- CreateIndex
CREATE UNIQUE INDEX "space_invites_spaceId_email_key" ON "space_invites"("spaceId", "email");

-- CreateIndex
CREATE INDEX "space_events_spaceId_at_idx" ON "space_events"("spaceId", "at");

-- AddForeignKey
ALTER TABLE "space_members" ADD CONSTRAINT "space_members_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "space_members" ADD CONSTRAINT "space_members_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "space_boxes" ADD CONSTRAINT "space_boxes_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "space_boxes" ADD CONSTRAINT "space_boxes_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "space_invites" ADD CONSTRAINT "space_invites_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- CreateTable
CREATE TABLE "space_charges" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "bytes" BIGINT NOT NULL,
    "liveUntil" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "key" TEXT,
    "uploadId" TEXT,
    "partNumbers" INTEGER[] DEFAULT ARRAY[]::INTEGER[],

    CONSTRAINT "space_charges_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "space_charges_spaceId_liveUntil_idx" ON "space_charges"("spaceId", "liveUntil");

-- AddForeignKey
ALTER TABLE "space_charges" ADD CONSTRAINT "space_charges_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

