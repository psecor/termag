-- The Claude tier an ask asked for (`termag ask --model`) until it starts, then
-- the one its turn launched on; null for the box's default. `modelIgnored`: why
-- an asked-for tier did not reach the turn (an older box agent, a headless
-- run). Additive only.

-- AlterTable
ALTER TABLE "agent_messages" ADD COLUMN "model" TEXT,
ADD COLUMN "modelIgnored" TEXT;
