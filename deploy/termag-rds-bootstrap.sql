-- One-time role bootstrap for the orchestrator's Aurora database
--. Run as the cluster's master user, `administrator`,
-- connected to the `termag` database, over an SSM port-forward through the
-- orchestrator host:
--
--   psql "host=127.0.0.1 port=15432 dbname=termag user=administrator sslmode=require" \
--     -v ON_ERROR_STOP=1 -f termag-rds-bootstrap.sql
--
-- Safe to re-run: every step checks first or is idempotent.
--
--   migration    IAM auth; owns the database, the public schema and every table.
--                db:push and termag-rds-cutover connect as it.
--   application  IAM auth; DML only. The running backend connects as it.
--
-- `rds_iam` is the RDS-provided role that switches a login to IAM-token auth.

\set ON_ERROR_STOP on

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'migration') THEN
    CREATE ROLE migration LOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'application') THEN
    CREATE ROLE application LOGIN;
  END IF;
END
$$;

GRANT rds_iam TO migration;
GRANT rds_iam TO application;

-- Lets the master user hand ownership to migration.
GRANT migration TO CURRENT_USER;

DO $$
BEGIN
  EXECUTE format('ALTER DATABASE %I OWNER TO migration', current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO application', current_database());
END
$$;

ALTER SCHEMA public OWNER TO migration;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO application;

-- Everything migration creates later: db:push and the cutover's pg_restore.
ALTER DEFAULT PRIVILEGES FOR ROLE migration IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO application;
ALTER DEFAULT PRIVILEGES FOR ROLE migration IN SCHEMA public
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO application;

-- Anything already there, for a re-run after objects were created some other way.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO application;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO application;
