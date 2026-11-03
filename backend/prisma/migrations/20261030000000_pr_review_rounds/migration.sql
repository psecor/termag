-- What the user posted on a PR from the simple UI's review card, one row a round.
CREATE TABLE "pr_review_rounds" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "repo" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "round" INTEGER NOT NULL,
    "headSha" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "comments" INTEGER NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "author" TEXT,
    "postedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pr_review_rounds_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "pr_review_rounds_userId_repo_number_round_key" ON "pr_review_rounds"("userId", "repo", "number", "round");
CREATE INDEX "pr_review_rounds_userId_postedAt_idx" ON "pr_review_rounds"("userId", "postedAt");

ALTER TABLE "pr_review_rounds" ADD CONSTRAINT "pr_review_rounds_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
