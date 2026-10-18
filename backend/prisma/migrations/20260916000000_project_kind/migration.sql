-- Project.kind: "normal" | "metaterm". MetaTerm is a per-user singleton
-- control-tower project living on the orchestrator (instanceId NULL).
-- @@unique([userId, instanceId, name]) can't enforce the singleton because
-- NULL instanceId values are distinct in Postgres, so use a partial unique.
ALTER TABLE "projects" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'normal';
CREATE UNIQUE INDEX "projects_userId_metaterm_key" ON "projects" ("userId") WHERE "kind" = 'metaterm';
