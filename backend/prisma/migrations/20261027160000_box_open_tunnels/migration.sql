-- Native port forward: open port-forward tunnels in the
-- agent's latest host sample, for the lifecycle sweep's `tunnels` busy check.
-- Additive only.

-- AlterTable
ALTER TABLE "instances" ADD COLUMN     "openTunnels" INTEGER;
