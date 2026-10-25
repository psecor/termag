-- AlterTable
ALTER TABLE "agent_threads" ADD COLUMN     "chatWorkstreamId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "agent_threads_chatWorkstreamId_key" ON "agent_threads"("chatWorkstreamId");

-- AddForeignKey
ALTER TABLE "agent_threads" ADD CONSTRAINT "agent_threads_chatWorkstreamId_fkey" FOREIGN KEY ("chatWorkstreamId") REFERENCES "workstreams"("id") ON DELETE SET NULL ON UPDATE CASCADE;
