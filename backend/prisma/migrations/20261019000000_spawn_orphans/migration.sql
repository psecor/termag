-- AlterTable
ALTER TABLE "users" ADD COLUMN     "spawnOrphanHome" JSONB;

-- AlterTable
ALTER TABLE "agent_spawns" ADD COLUMN     "adoptedAt" TIMESTAMP(3),
ADD COLUMN     "adoptedBy" TEXT,
ADD COLUMN     "fosterProjectId" TEXT,
ADD COLUMN     "fosterRole" TEXT,
ADD COLUMN     "fosterWorkstream" TEXT,
ADD COLUMN     "orphanedAt" TIMESTAMP(3);

