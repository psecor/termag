-- Suggested review groups the user dismissed (phase 3).
CREATE TABLE "pr_group_suggestion_dismissals" (
    "userId" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pr_group_suggestion_dismissals_pkey" PRIMARY KEY ("userId","keyHash")
);

ALTER TABLE "pr_group_suggestion_dismissals" ADD CONSTRAINT "pr_group_suggestion_dismissals_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
