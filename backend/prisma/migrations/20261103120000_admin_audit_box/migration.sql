-- admin_audit_log.boxId: the box whose own agent token made an admin call.
-- Only an admin's box reading or triaging bug reports from the CLI sets it;
-- null for browser sessions, admin tokens and MCP.
ALTER TABLE "admin_audit_log" ADD COLUMN "boxId" TEXT;
