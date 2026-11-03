-- When the power sweep last settled a box's stop or hibernate, for
-- box.resumed's downMinutes (docs/agents/observability.md). Additive only.

-- AlterTable
ALTER TABLE "instances" ADD COLUMN     "downSince" TIMESTAMP(3);
