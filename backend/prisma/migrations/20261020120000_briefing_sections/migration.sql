-- AlterTable
ALTER TABLE "briefings" ADD COLUMN "charts" JSONB,
ADD COLUMN "patterns" JSONB;

-- CreateTable
CREATE TABLE "briefing_dismissals" (
    "userId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "until" TIMESTAMP(3) NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "briefing_dismissals_pkey" PRIMARY KEY ("userId","key")
);

-- AddForeignKey
ALTER TABLE "briefing_dismissals" ADD CONSTRAINT "briefing_dismissals_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
