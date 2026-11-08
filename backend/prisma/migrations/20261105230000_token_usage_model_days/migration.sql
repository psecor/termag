-- token_usage_days split by model (and pi's provider as backend), written by the sampler beside the day rows. Additive only.

-- CreateTable
CREATE TABLE "token_usage_model_days" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "hostKey" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "backend" TEXT NOT NULL DEFAULT '',
    "projectId" TEXT,
    "workstream" TEXT,
    "input" BIGINT NOT NULL DEFAULT 0,
    "output" BIGINT NOT NULL DEFAULT 0,
    "cacheRead" BIGINT NOT NULL DEFAULT 0,
    "cacheCreate" BIGINT NOT NULL DEFAULT 0,
    "reasoning" BIGINT NOT NULL DEFAULT 0,
    "calls" INTEGER NOT NULL DEFAULT 0,
    "scannedAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "token_usage_model_days_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "token_usage_model_days_date_idx" ON "token_usage_model_days"("date");

-- CreateIndex
CREATE UNIQUE INDEX "token_usage_model_days_userId_hostKey_provider_date_sourceK_key" ON "token_usage_model_days"("userId", "hostKey", "provider", "date", "sourceKey", "backend", "model");

-- AddForeignKey
ALTER TABLE "token_usage_model_days" ADD CONSTRAINT "token_usage_model_days_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "token_usage_model_days" ADD CONSTRAINT "token_usage_model_days_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

