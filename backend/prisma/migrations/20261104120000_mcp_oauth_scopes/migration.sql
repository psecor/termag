-- AlterTable
ALTER TABLE "mcp_connectors" ADD COLUMN     "oauthScopes" JSONB;

-- AlterTable
ALTER TABLE "mcp_oauth_states" ADD COLUMN     "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[];
