-- The model backend an agent workflow's harness runs on, and the model it
-- starts on, e.g. fireworks and
-- accounts/fireworks/models/kimi-k3. Null is the default. Additive only.

-- AlterTable
ALTER TABLE "workflows" ADD COLUMN "backend" TEXT;
ALTER TABLE "workflows" ADD COLUMN "model" TEXT;
