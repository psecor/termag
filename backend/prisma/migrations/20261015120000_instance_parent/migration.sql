-- The box whose credentials created this one, for an ask. Additive only: the column is nullable, so a process from
-- before it keeps working during an overlapping deploy.

-- AlterTable
ALTER TABLE "instances" ADD COLUMN "parentInstanceId" TEXT;

-- CreateIndex
CREATE INDEX "instances_parentInstanceId_idx" ON "instances"("parentInstanceId");

-- AddForeignKey
ALTER TABLE "instances" ADD CONSTRAINT "instances_parentInstanceId_fkey" FOREIGN KEY ("parentInstanceId") REFERENCES "instances"("id") ON DELETE SET NULL ON UPDATE CASCADE;
