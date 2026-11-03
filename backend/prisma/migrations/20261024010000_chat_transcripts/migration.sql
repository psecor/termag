-- Chat transcripts stored by the orchestrator. Additive only.

-- CreateTable
CREATE TABLE "chat_transcripts" (
    "projectId" TEXT NOT NULL,
    "workstreamId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "rawBytes" BIGINT NOT NULL DEFAULT 0,
    "rawCapped" BOOLEAN NOT NULL DEFAULT false,
    "current" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chat_transcripts_pkey" PRIMARY KEY ("projectId","workstreamId","sessionId")
);

-- CreateTable
CREATE TABLE "chat_transcript_chunks" (
    "projectId" TEXT NOT NULL,
    "workstreamId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "byteStart" BIGINT NOT NULL,
    "byteEnd" BIGINT NOT NULL,
    "sealed" BOOLEAN NOT NULL,
    "raw" BYTEA,
    "entries" BYTEA NOT NULL,
    "entryCount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_transcript_chunks_pkey" PRIMARY KEY ("projectId","workstreamId","sessionId","byteStart")
);

-- CreateIndex
CREATE INDEX "chat_transcripts_workstreamId_current_idx" ON "chat_transcripts"("workstreamId", "current");

-- AddForeignKey
ALTER TABLE "chat_transcripts" ADD CONSTRAINT "chat_transcripts_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_transcripts" ADD CONSTRAINT "chat_transcripts_workstreamId_fkey" FOREIGN KEY ("workstreamId") REFERENCES "workstreams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_transcript_chunks" ADD CONSTRAINT "chat_transcript_chunks_projectId_workstreamId_sessionId_fkey" FOREIGN KEY ("projectId", "workstreamId", "sessionId") REFERENCES "chat_transcripts"("projectId", "workstreamId", "sessionId") ON DELETE CASCADE ON UPDATE CASCADE;

