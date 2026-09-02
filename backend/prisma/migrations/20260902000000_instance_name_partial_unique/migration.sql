-- A terminated box must NOT keep reserving its (userId, name) slot: the app
-- treats terminated box names as reusable (the create pre-check ignores
-- terminated rows). The original full unique index counted terminated rows,
-- so re-creating a box with a previously-terminated name hit a P2002 crash.
--
-- Replace the full unique with a PARTIAL unique that excludes terminated boxes.
-- Prisma can't model partial uniques, so this index is managed here (the
-- Instance model drops @@unique and documents this).
DROP INDEX "instances_userId_name_key";
CREATE UNIQUE INDEX "instances_userId_name_active_key"
  ON "instances" ("userId", "name")
  WHERE "status" <> 'terminated';
