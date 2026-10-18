-- Automatic box lifecycle: the per-box idle
-- hibernate setting and the clocks the lifecycle sweep reads. Additive only.

-- AlterTable
ALTER TABLE "instances" ADD COLUMN     "idleHibernateHours" INTEGER,
ADD COLUMN     "lastActivityAt" TIMESTAMP(3),
ADD COLUMN     "parkedAt" TIMESTAMP(3),
ADD COLUMN     "lifecycleNote" TEXT;
