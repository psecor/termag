-- Workstream.slackChannelId: each non-main workstream gets its own Slack
-- channel (#proj-<user>-<project>-<workstream>) so /t can route to that
-- worktree's tmux pair. The main workstream keeps using Project.slackChannelId.
ALTER TABLE "workstreams" ADD COLUMN "slackChannelId" TEXT;
