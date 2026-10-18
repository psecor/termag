-- Daily engagement-ladder segments per user.

-- CreateTable
CREATE TABLE "user_segment_daily" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "segment" TEXT NOT NULL,
    "agentMs" INTEGER NOT NULL DEFAULT 0,
    "humanMs" INTEGER NOT NULL DEFAULT 0,
    "tokenRows" INTEGER NOT NULL DEFAULT 0,
    "visited" BOOLEAN NOT NULL DEFAULT false,
    "computedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_segment_daily_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_segment_daily_user_id_date_key" ON "user_segment_daily"("userId", "date");

-- CreateIndex
CREATE INDEX "user_segment_daily_date_idx" ON "user_segment_daily"("date");

-- AddForeignKey
ALTER TABLE "user_segment_daily" ADD CONSTRAINT "user_segment_daily_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
