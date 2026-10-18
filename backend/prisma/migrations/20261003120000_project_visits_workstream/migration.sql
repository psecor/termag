-- Which workstream a visit landed on. NULL = recorded before this column
-- existed (treated as "main" when reading). Lets "Recents" distinguish a
-- worktree session from the project's main session.
ALTER TABLE "project_visits" ADD COLUMN "workstream" TEXT;
