-- CreateTable
CREATE TABLE "session_pins" (
    "userId" TEXT NOT NULL,
    "workstreamId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "session_pins_pkey" PRIMARY KEY ("userId","workstreamId")
);

-- CreateIndex
CREATE INDEX "session_pins_workstreamId_idx" ON "session_pins"("workstreamId");

-- AddForeignKey
ALTER TABLE "session_pins" ADD CONSTRAINT "session_pins_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_pins" ADD CONSTRAINT "session_pins_workstreamId_fkey" FOREIGN KEY ("workstreamId") REFERENCES "workstreams"("id") ON DELETE CASCADE ON UPDATE CASCADE;
