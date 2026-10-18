-- CreateTable
CREATE TABLE "workstream_prs" (
    "userId" TEXT NOT NULL,
    "repo" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "workstreamId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workstream_prs_pkey" PRIMARY KEY ("userId","repo","number")
);

-- CreateIndex
CREATE INDEX "workstream_prs_workstreamId_idx" ON "workstream_prs"("workstreamId");

-- AddForeignKey
ALTER TABLE "workstream_prs" ADD CONSTRAINT "workstream_prs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workstream_prs" ADD CONSTRAINT "workstream_prs_workstreamId_fkey" FOREIGN KEY ("workstreamId") REFERENCES "workstreams"("id") ON DELETE CASCADE ON UPDATE CASCADE;
