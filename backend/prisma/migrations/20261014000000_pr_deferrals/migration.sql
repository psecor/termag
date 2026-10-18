-- CreateTable
CREATE TABLE "pr_deferrals" (
    "userId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "until" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pr_deferrals_pkey" PRIMARY KEY ("userId","key")
);

-- AddForeignKey
ALTER TABLE "pr_deferrals" ADD CONSTRAINT "pr_deferrals_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
