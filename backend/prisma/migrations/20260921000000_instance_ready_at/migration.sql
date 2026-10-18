-- Instance.readyAt: the first time a box's agent dialed in, written once on
-- the provisioning -> ready transition. readyAt - createdAt is the cold
-- provisioning baseline, which lastConnectedAt cannot give because every
-- reconnect overwrites it. No backfill: rows whose first connect predates
-- this column keep NULL.
ALTER TABLE "instances" ADD COLUMN "readyAt" TIMESTAMP(3);
