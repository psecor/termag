-- Drop the legacy (projectId, type) unique constraint on workflows so a
-- project can carry one agent workflow per workstream (in addition to the
-- existing (workstreamId, type) unique index, which keeps per-workstream
-- one-of-each).
--
-- workflows.projectId is intentionally retained for now; the column gets
-- dropped in a later migration once nothing reads it directly.

DROP INDEX IF EXISTS "workflows_projectId_type_key";
