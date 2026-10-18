-- When the user finished (or skipped) the first-run setup wizard. NULL means
-- never; the wizard is offered while this is NULL and the user has no projects.
ALTER TABLE "users" ADD COLUMN "onboardedAt" TIMESTAMP(3);
