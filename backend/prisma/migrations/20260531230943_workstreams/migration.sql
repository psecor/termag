-- Phase 1 of project → workstream restructure.
--
-- Adds a Workstream layer between Project and Workflow. Every existing
-- project gets a single workstream named "main" so the user-facing flow is
-- unchanged (the UI will collapse single-workstream projects).
--
-- Backward compat: `workflows.projectId` is kept alongside the new
-- `workflows.workstreamId`. Phase 2 will swap backend code to use the
-- workstream-routed path and drop the redundant column.
--
-- Also widens projects' uniqueness from (userId, name) to (userId,
-- instanceId, name) so two boxes can host projects of the same name
-- without collision.

BEGIN;

-- CreateTable: workstreams
CREATE TABLE "workstreams" (
    "id"           TEXT NOT NULL,
    "projectId"    TEXT NOT NULL,
    "name"         TEXT NOT NULL,
    "branch"       TEXT NOT NULL,
    "archived"     BOOLEAN NOT NULL DEFAULT false,
    "lastActiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"    TIMESTAMP(3) NOT NULL,
    CONSTRAINT "workstreams_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "workstreams_projectId_name_key" ON "workstreams"("projectId", "name");
CREATE INDEX "workstreams_projectId_idx" ON "workstreams"("projectId");

ALTER TABLE "workstreams" ADD CONSTRAINT "workstreams_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Data: one "main" workstream per existing project.
-- Use a cuid-ish id ('ws_' + 24 hex chars from gen_random_uuid) so the id is
-- unique, opaque, and easy to spot in logs.
INSERT INTO "workstreams" ("id", "projectId", "name", "branch", "lastActiveAt", "createdAt", "updatedAt")
SELECT
    'ws_' || substring(replace(gen_random_uuid()::text, '-', '') from 1 for 24),
    "id",
    'main',
    'main',
    "lastActiveAt",
    "createdAt",
    CURRENT_TIMESTAMP
FROM "projects";

-- AlterTable: workflows.workstreamId (add nullable, backfill, set NOT NULL)
ALTER TABLE "workflows" ADD COLUMN "workstreamId" TEXT;

UPDATE "workflows" SET "workstreamId" = (
    SELECT "id" FROM "workstreams"
    WHERE "workstreams"."projectId" = "workflows"."projectId"
);

ALTER TABLE "workflows" ALTER COLUMN "workstreamId" SET NOT NULL;

ALTER TABLE "workflows" ADD CONSTRAINT "workflows_workstreamId_fkey"
    FOREIGN KEY ("workstreamId") REFERENCES "workstreams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "workflows_workstreamId_type_key" ON "workflows"("workstreamId", "type");
CREATE INDEX "workflows_workstreamId_idx" ON "workflows"("workstreamId");

-- Widen project uniqueness to include instanceId.
-- The old (userId, name) constraint was strictly stricter than the new one,
-- so existing data already satisfies the new constraint — no conflicts.
ALTER TABLE "projects" DROP CONSTRAINT IF EXISTS "projects_userId_name_key";
DROP INDEX IF EXISTS "projects_userId_name_key";
CREATE UNIQUE INDEX "projects_userId_instanceId_name_key" ON "projects"("userId", "instanceId", "name");

COMMIT;
