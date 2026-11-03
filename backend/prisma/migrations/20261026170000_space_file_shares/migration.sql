-- Sharing one space file read-only with anyone signed in to termag.
-- Additive only.

-- CreateTable
CREATE TABLE "space_file_shares" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "sharedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "space_file_shares_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "space_file_shares_spaceId_path_key" ON "space_file_shares"("spaceId", "path");

-- AddForeignKey
ALTER TABLE "space_file_shares" ADD CONSTRAINT "space_file_shares_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
