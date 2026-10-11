-- Per-user theme settings (src/theme/schema.ts). {} means all defaults.
ALTER TABLE "users" ADD COLUMN "theme" JSONB NOT NULL DEFAULT '{}';
