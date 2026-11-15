-- When a person answered Lab's toast recommending termag's chat, by taking it
-- or dismissing it; it isn't
-- shown again. NULL means not answered. Read and written only under
-- chat-ui-nudge-enabled. Additive and nullable.
ALTER TABLE "users" ADD COLUMN "chatNudgeDismissedAt" TIMESTAMP(3);
