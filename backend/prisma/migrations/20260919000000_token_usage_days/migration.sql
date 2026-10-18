-- Per-project token usage: daily totals per (user, host, provider, raw source
-- bucket), upserted by the server-side sampler from agents' usage-scan responses.
CREATE TABLE "token_usage_days" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "hostKey" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "date" TEXT NOT NULL,
  "sourceKey" TEXT NOT NULL,
  "cwdHint" TEXT,
  "projectId" TEXT,
  "workstream" TEXT,
  "input" BIGINT NOT NULL DEFAULT 0,
  "output" BIGINT NOT NULL DEFAULT 0,
  "cacheRead" BIGINT NOT NULL DEFAULT 0,
  "cacheCreate" BIGINT NOT NULL DEFAULT 0,
  "calls" INTEGER NOT NULL DEFAULT 0,
  "estimated" BOOLEAN NOT NULL DEFAULT false,
  "agentSchema" INTEGER NOT NULL DEFAULT 1,
  "scannedAt" TIMESTAMP(3) NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "token_usage_days_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "token_usage_days_userId_hostKey_provider_date_sourceKey_key"
  ON "token_usage_days"("userId", "hostKey", "provider", "date", "sourceKey");
CREATE INDEX "token_usage_days_userId_date_idx" ON "token_usage_days"("userId", "date");
CREATE INDEX "token_usage_days_projectId_date_idx" ON "token_usage_days"("projectId", "date");
ALTER TABLE "token_usage_days" ADD CONSTRAINT "token_usage_days_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "token_usage_days" ADD CONSTRAINT "token_usage_days_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;
