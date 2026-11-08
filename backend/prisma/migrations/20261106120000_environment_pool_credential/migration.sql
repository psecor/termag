-- Environment pools: the environment a pool box was launched for, which
-- the GitHub broker reads to scope the pool credential's fetches, and that credential itself, sealed
-- (services/poolCredential.ts). Deploys sync the schema with `prisma db push`; this file is the record.
ALTER TABLE "instances" ADD COLUMN "poolEnvironmentId" TEXT;

CREATE TABLE "pool_credentials" (
    "provider" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "ciphertext" BYTEA NOT NULL,
    "updatedByUserId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pool_credentials_pkey" PRIMARY KEY ("provider")
);
