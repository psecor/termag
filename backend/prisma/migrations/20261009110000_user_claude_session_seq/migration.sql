-- The last "Claude Cloud N" handed to each owner. Additive, defaulted; the
-- run rows' sessionSeq is drawn from it, so numbers never repeat after the
-- 90-day run retention deletes the rows that carried them.
ALTER TABLE "users" ADD COLUMN "claudeSessionSeq" INTEGER NOT NULL DEFAULT 0;
