-- AlterTable
ALTER TABLE "mcp_connectors" ADD COLUMN "oauthMetadata" JSONB,
ADD COLUMN "linkStatus" TEXT,
ADD COLUMN "linkError" TEXT;

-- CreateTable
CREATE TABLE "mcp_oauth_states" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "connectorId" TEXT NOT NULL,
    "codeVerifier" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mcp_oauth_states_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "mcp_oauth_states_expiresAt_idx" ON "mcp_oauth_states"("expiresAt");

-- AddForeignKey
ALTER TABLE "mcp_oauth_states" ADD CONSTRAINT "mcp_oauth_states_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mcp_oauth_states" ADD CONSTRAINT "mcp_oauth_states_connectorId_fkey" FOREIGN KEY ("connectorId") REFERENCES "mcp_connectors"("id") ON DELETE CASCADE ON UPDATE CASCADE;
