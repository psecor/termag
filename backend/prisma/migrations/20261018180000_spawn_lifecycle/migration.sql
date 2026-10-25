-- AlterTable
ALTER TABLE "agent_spawns" ADD COLUMN     "keptReason" TEXT,
ADD COLUMN     "parkedAt" TIMESTAMP(3),
ADD COLUMN     "retiredAt" TIMESTAMP(3);

