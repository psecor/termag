-- Stored ask replies: each finished
-- message's final reply, sealed, kept 14 days. A new table, additive only.

-- CreateTable
CREATE TABLE "ask_replies" (
    "messageId" TEXT NOT NULL,
    "sealed" BOOLEAN NOT NULL,
    "text" BYTEA NOT NULL,
    "bytes" INTEGER NOT NULL,
    "truncated" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ask_replies_pkey" PRIMARY KEY ("messageId")
);

-- CreateIndex
CREATE INDEX "ask_replies_createdAt_idx" ON "ask_replies"("createdAt");

-- AddForeignKey
ALTER TABLE "ask_replies" ADD CONSTRAINT "ask_replies_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "agent_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

