-- Where a project is listed among spaces, kept when its box terminates. The spaces sweep records it from grants, so it fills in on the first sweep. `instanceId` is the box the project was on when listed: only that box counts as listed, so a project that moves to another box doesn't take the space with it.
-- CreateTable
CREATE TABLE "project_spaces" (
    "projectId" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "addedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_spaces_pkey" PRIMARY KEY ("projectId","spaceId")
);

-- CreateIndex
CREATE INDEX "project_spaces_spaceId_idx" ON "project_spaces"("spaceId");

-- AddForeignKey
ALTER TABLE "project_spaces" ADD CONSTRAINT "project_spaces_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_spaces" ADD CONSTRAINT "project_spaces_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

