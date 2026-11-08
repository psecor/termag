-- The MCP connector's name as typed, shown in Settings; null means the
-- connector name itself is the display name (every existing row).
ALTER TABLE "mcp_connectors" ADD COLUMN "displayName" TEXT;
