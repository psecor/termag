-- The root disk a box was asked for at creation, and got at launch
-- (services/boxDiskSize.ts). Additive only.

-- AlterTable
ALTER TABLE "instances" ADD COLUMN     "diskGiB" INTEGER;
