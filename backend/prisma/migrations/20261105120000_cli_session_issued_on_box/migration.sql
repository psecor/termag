-- Where a CLI device sign-in was made: the box, when the CLI sent its credential
-- with the code exchange. Nullable: every earlier sign-in reads as not on a box.
ALTER TABLE "cli_sessions" ADD COLUMN "issuedOnBoxId" TEXT;
