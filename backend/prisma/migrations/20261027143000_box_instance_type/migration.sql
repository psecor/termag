-- Preview fleet, PR 2: the EC2 type a box launched as,
-- the configured one, a fallback, or a caller's own. Additive only.

-- AlterTable
ALTER TABLE "instances" ADD COLUMN     "instanceType" TEXT;
