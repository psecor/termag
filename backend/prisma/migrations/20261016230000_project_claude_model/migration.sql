-- The Claude model a simple-UI chat launches with (opus, sonnet, haiku).
-- Null is Auto: the chat launch omits --model and Claude uses its default.
-- Additive only.

-- AlterTable
ALTER TABLE "projects" ADD COLUMN "claudeModel" TEXT;
