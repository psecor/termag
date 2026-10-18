-- host pressure on the box row (from the agent's hello and host-sample RPC) and
-- the session directory's size and kept flag on the run row (from the wrapper's ended report).
-- Additive only.

-- AlterTable
ALTER TABLE "instances" ADD COLUMN     "diskUsedPct" INTEGER,
ADD COLUMN     "memUsedPct" INTEGER,
ADD COLUMN     "load1" DOUBLE PRECISION,
ADD COLUMN     "keptCheckouts" INTEGER,
ADD COLUMN     "hostSampledAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "claude_runner_sessions" ADD COLUMN     "checkoutBytes" BIGINT,
ADD COLUMN     "kept" BOOLEAN;
