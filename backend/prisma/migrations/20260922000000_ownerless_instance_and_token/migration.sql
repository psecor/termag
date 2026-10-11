-- A warm-pool box exists before anyone asks for it, so it has no owner while it
-- boots and waits to be claimed. Drop NOT NULL on the owning column of both the
-- box and its instance-bound token: the token authenticates the box itself, so
-- it is ownerless for exactly as long as the box is. The partial unique index
-- on ("userId", "name") is deliberately untouched — Postgres treats nulls as
-- distinct, so ownerless rows never collide on it.
--
-- The new "instances" columns carry the pool lifecycle the reconciler reads in
-- a later change: which pool spec the box launched from, the timestamps that
-- order claims and bound the claim and disconnect windows, and the outcome of
-- the on-warm and on-claim runners.
ALTER TABLE "instances" ALTER COLUMN "userId" DROP NOT NULL;
ALTER TABLE "agent_tokens" ALTER COLUMN "userId" DROP NOT NULL;

ALTER TABLE "instances" ADD COLUMN "poolSpecHash" TEXT;
ALTER TABLE "instances" ADD COLUMN "warmedAt" TIMESTAMP(3);
ALTER TABLE "instances" ADD COLUMN "claimedAt" TIMESTAMP(3);
ALTER TABLE "instances" ADD COLUMN "agentDisconnectedAt" TIMESTAMP(3);
ALTER TABLE "instances" ADD COLUMN "onWarmStatus" TEXT;
ALTER TABLE "instances" ADD COLUMN "onWarmLog" TEXT;
ALTER TABLE "instances" ADD COLUMN "onClaimStatus" TEXT;
ALTER TABLE "instances" ADD COLUMN "onClaimError" TEXT;
