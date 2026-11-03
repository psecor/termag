-- An ask thread's display title:
-- `termag ask --title`, else the prompt's first heading or line, cut to 80
-- characters. What the simple UI names the thread's chat by. Additive only.

-- AlterTable
ALTER TABLE "agent_threads" ADD COLUMN     "title" TEXT;
