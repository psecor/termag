-- The IANA zone this person's termag clients last reported (the web UI and
-- the desktop send theirs when they read working time), so working time is
-- banked by their local day rather than the orchestrator's. NULL until a
-- client reports one; working time then keeps the orchestrator's day.
ALTER TABLE "users" ADD COLUMN "timeZone" TEXT;
