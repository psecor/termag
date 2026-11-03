-- An automation's kind (services/automations): `chat` (each run a chat-runner
-- turn, every automation so far) or `t3` (each run calls a T3 Code scheduled
-- task's webhook on the box). Two additive columns with a default, so an older
-- process neither reads nor needs them, and every existing row is `chat`.
ALTER TABLE "automations" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'chat';
ALTER TABLE "automations" ADD COLUMN "t3TaskId" TEXT;
