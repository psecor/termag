-- Same-named projects on two boxes must not share a notification channel
-- or a work-time bucket. "" is the orchestrator and every row that existed
-- before instance identity.
-- notification_targets was created by schema sync on some databases and is
-- absent from earlier migrations, so create it when missing.

CREATE TABLE IF NOT EXISTS "notification_targets" (
    "tmuxSession" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL DEFAULT '',
    "channel" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "notification_targets_pkey" PRIMARY KEY ("tmuxSession", "platform", "instanceId")
);

ALTER TABLE "notification_targets" ADD COLUMN IF NOT EXISTS "instanceId" TEXT NOT NULL DEFAULT '';

ALTER TABLE "notification_targets" DROP CONSTRAINT IF EXISTS "notification_targets_pkey";

ALTER TABLE "notification_targets" ADD CONSTRAINT "notification_targets_pkey"
    PRIMARY KEY ("tmuxSession", "platform", "instanceId");

ALTER TABLE "work_time_entries" ADD COLUMN "instanceId" TEXT NOT NULL DEFAULT '';

DROP INDEX "work_time_entries_username_project_provider_date_key";

CREATE UNIQUE INDEX "work_time_entries_username_project_provider_date_instanceId_key"
    ON "work_time_entries"("username", "project", "provider", "date", "instanceId");
