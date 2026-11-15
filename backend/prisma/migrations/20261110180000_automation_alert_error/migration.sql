-- The last failed alert send per automation ("Alerts
-- and the outbound webhook"): shown by `termag automation show` and the full
-- UI, cleared by the next send that goes. Additive and nullable.

-- AlterTable
ALTER TABLE "automations" ADD COLUMN     "lastAlertError" TEXT,
ADD COLUMN     "lastAlertErrorAt" TIMESTAMP(3);
