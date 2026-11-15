-- A path's newest put (spaceStore.lastPutAt / lastWrite, run on every upload confirm) filtered the
-- whole space history newest-first through (spaceId, at). This lets it seek straight to the path.
--
-- Production does not run this file: it syncs its schema with `db:push` (backend/src/scripts/dbPush.ts),
-- and the 2026-11-13 slowdown hotfix built this index there by hand under this exact name. IF NOT EXISTS
-- keeps this a no-op wherever it does run (a `migrate deploy` on a database that has the index).
-- CONCURRENTLY so building it does not block writes to space_events; it must be the file's only statement.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "space_events_spaceId_path_action_at_idx" ON "space_events"("spaceId", "path", "action", "at");
