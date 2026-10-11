-- CreateTable
CREATE TABLE "ssh_public_keys" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ssh_public_keys_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ssh_public_keys_userId_fingerprint_key" ON "ssh_public_keys"("userId", "fingerprint");

-- AddForeignKey
ALTER TABLE "ssh_public_keys" ADD CONSTRAINT "ssh_public_keys_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
