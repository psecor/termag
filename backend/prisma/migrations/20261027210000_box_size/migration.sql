-- Box sizes (services/boxSize.ts): the size a box launched at, small, medium
-- or large; null for the configured BOX_INSTANCE_TYPE. Additive only.

-- AlterTable
ALTER TABLE "instances" ADD COLUMN     "size" TEXT;
