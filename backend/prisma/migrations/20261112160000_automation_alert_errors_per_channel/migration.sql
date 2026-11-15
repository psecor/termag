-- Each channel's last failed alert send ("Alerts and
-- the outbound webhook"), so a success on one channel can't clear the other's
-- failure. Additive and nullable. lastAlertError / lastAlertErrorAt, which
-- these replace, are left for a later release to drop (expand, then contract).

-- AlterTable
ALTER TABLE "automations" ADD COLUMN     "lastSlackError" TEXT,
ADD COLUMN     "lastSlackErrorAt" TIMESTAMP(3),
ADD COLUMN     "lastWebhookError" TEXT,
ADD COLUMN     "lastWebhookErrorAt" TIMESTAMP(3);

-- Carry a failure from the single column into its channel's. Deploys run
-- `db push`, which skips this, so the view also reads the legacy column as a
-- fallback (store.ts alertErrorsView); this only spares it the work.
UPDATE "automations" SET "lastSlackError" = substr("lastAlertError", 8), "lastSlackErrorAt" = "lastAlertErrorAt"
WHERE "lastAlertError" LIKE 'Slack: %' AND "lastAlertErrorAt" IS NOT NULL AND "lastSlackErrorAt" IS NULL;
UPDATE "automations" SET "lastWebhookError" = substr("lastAlertError", 10), "lastWebhookErrorAt" = "lastAlertErrorAt"
WHERE "lastAlertError" LIKE 'webhook: %' AND "lastAlertErrorAt" IS NOT NULL AND "lastWebhookErrorAt" IS NULL;
