DO $bootstrap$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'migrator') THEN
    CREATE ROLE migrator NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app') THEN
    CREATE ROLE app LOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'identity') THEN
    CREATE ROLE identity LOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'platform') THEN
    CREATE ROLE platform LOGIN NOINHERIT;
  END IF;
END
$bootstrap$;

DO $bootstrap$
BEGIN
  EXECUTE format('GRANT CREATE ON DATABASE %I TO migrator', current_database());
  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format('REVOKE CREATE ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format('GRANT migrator TO %I', current_user);
END
$bootstrap$;

CREATE SCHEMA IF NOT EXISTS migrator AUTHORIZATION migrator;

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
