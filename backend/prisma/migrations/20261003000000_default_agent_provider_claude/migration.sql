-- New users default to Claude: Codex is no longer selectable in the create-project
-- picker (it stays in the registry so existing Codex projects keep working). No
-- backfill: users who chose codex keep it until they pick something else.
ALTER TABLE "users" ALTER COLUMN "defaultAgentProvider" SET DEFAULT 'claude';
