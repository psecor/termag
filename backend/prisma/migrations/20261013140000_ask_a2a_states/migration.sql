-- Message states take A2A's TaskState names.
ALTER TABLE "agent_messages" ALTER COLUMN "status" SET DEFAULT 'submitted';

UPDATE "agent_messages" SET "status" = CASE "status"
    WHEN 'queued' THEN 'submitted'
    WHEN 'running' THEN 'working'
    WHEN 'done' THEN 'completed'
  END
WHERE "status" IN ('queued', 'running', 'done');
