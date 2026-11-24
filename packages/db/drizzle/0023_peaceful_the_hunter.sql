ALTER TABLE "app"."households" ADD COLUMN "status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."households" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app"."households" ADD COLUMN "deleted_by" uuid;--> statement-breakpoint
ALTER TABLE "app"."households" ADD COLUMN "emergency_contacts" "bytea";--> statement-breakpoint
CREATE INDEX "households_deleted_idx" ON "app"."households" USING btree ("org_id","community_id","deleted_at") WHERE "app"."households"."deleted_at" is not null;--> statement-breakpoint
ALTER TABLE "app"."households" ADD CONSTRAINT "households_status_check" CHECK ("app"."households"."status" in ('active', 'inactive'));--> statement-breakpoint
GRANT UPDATE (status, deleted_at, deleted_by, emergency_contacts) ON app.households TO app;--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.households_before_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, app
AS $$
BEGIN
  IF NEW.deleted_at IS NOT NULL OR NEW.deleted_by IS NOT NULL THEN
    RAISE EXCEPTION 'deleted_at and deleted_by must be null on insert';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.households_before_insert() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.households_before_insert() TO app;
--> statement-breakpoint
CREATE TRIGGER households_before_insert
  BEFORE INSERT ON app.households
  FOR EACH ROW
  EXECUTE FUNCTION app.households_before_insert();--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.households_before_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, app
AS $$
BEGIN
  IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
    IF EXISTS (
      SELECT 1
      FROM app.persons
      WHERE org_id = NEW.org_id
        AND community_id = NEW.community_id
        AND household_id = NEW.id
        AND is_minor = true
    ) THEN
      RAISE EXCEPTION 'cannot set deleted_at while a minor is in the household';
    END IF;
    IF NEW.deleted_at <> now() THEN
      RAISE EXCEPTION 'deleted_at must be set to now()';
    END IF;
    IF NEW.deleted_by IS NULL THEN
      RAISE EXCEPTION 'deleted_by must be set when deleted_at is set';
    END IF;
  ELSIF OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL THEN
    IF NEW.deleted_by IS NOT NULL THEN
      RAISE EXCEPTION 'deleted_by must be null when deleted_at is cleared';
    END IF;
  ELSIF OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NOT NULL THEN
    IF NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
      RAISE EXCEPTION 'cannot change deleted_at from one time to another';
    END IF;
    IF NEW.deleted_by IS DISTINCT FROM OLD.deleted_by THEN
      RAISE EXCEPTION 'cannot change deleted_by on a deleted household';
    END IF;
  ELSIF OLD.deleted_at IS NULL AND NEW.deleted_at IS NULL THEN
    IF NEW.deleted_by IS NOT NULL THEN
      RAISE EXCEPTION 'cannot set deleted_by when deleted_at is null';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.households_before_update() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.households_before_update() TO app;
--> statement-breakpoint
CREATE TRIGGER households_before_update
  BEFORE UPDATE ON app.households
  FOR EACH ROW
  EXECUTE FUNCTION app.households_before_update();--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.persons_before_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, app
AS $$
DECLARE
  v_deleted_at timestamptz;
BEGIN
  IF NEW.deleted_at IS NOT NULL OR NEW.deleted_by IS NOT NULL THEN
    RAISE EXCEPTION 'deleted_at and deleted_by must be null on insert';
  END IF;

  IF NEW.household_id IS NOT NULL THEN
    SELECT deleted_at INTO v_deleted_at
    FROM app.households
    WHERE org_id = NEW.org_id
      AND community_id = NEW.community_id
      AND id = NEW.household_id
    FOR SHARE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'household not found or not visible';
    END IF;

    IF v_deleted_at IS NOT NULL THEN
      RAISE EXCEPTION 'cannot place person in a deleted household';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.persons_before_insert() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.persons_before_insert() TO app;--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.persons_before_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, app
AS $$
DECLARE
  v_deleted_at timestamptz;
BEGIN
  IF OLD.is_minor AND NEW.household_id IS DISTINCT FROM OLD.household_id THEN
    RAISE EXCEPTION 'cannot change household of a minor';
  END IF;

  IF NEW.household_id IS DISTINCT FROM OLD.household_id AND NEW.household_id IS NOT NULL THEN
    SELECT deleted_at INTO v_deleted_at
    FROM app.households
    WHERE org_id = NEW.org_id
      AND community_id = NEW.community_id
      AND id = NEW.household_id
    FOR SHARE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'household not found or not visible';
    END IF;

    IF v_deleted_at IS NOT NULL THEN
      RAISE EXCEPTION 'cannot place person in a deleted household';
    END IF;
  END IF;

  IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
    IF OLD.is_minor THEN
      RAISE EXCEPTION 'cannot set deleted_at on a minor';
    END IF;
    IF NEW.deleted_at <> now() THEN
      RAISE EXCEPTION 'deleted_at must be set to now()';
    END IF;
    IF NEW.deleted_by IS NULL THEN
      RAISE EXCEPTION 'deleted_by must be set when deleted_at is set';
    END IF;
  ELSIF OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL THEN
    IF NEW.deleted_by IS NOT NULL THEN
      RAISE EXCEPTION 'deleted_by must be null when deleted_at is cleared';
    END IF;
  ELSIF OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NOT NULL THEN
    IF NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
      RAISE EXCEPTION 'cannot change deleted_at from one time to another';
    END IF;
    IF NEW.deleted_by IS DISTINCT FROM OLD.deleted_by THEN
      RAISE EXCEPTION 'cannot change deleted_by on a deleted person';
    END IF;
  ELSIF OLD.deleted_at IS NULL AND NEW.deleted_at IS NULL THEN
    IF NEW.deleted_by IS NOT NULL THEN
      RAISE EXCEPTION 'cannot set deleted_by when deleted_at is null';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.persons_before_update() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.persons_before_update() TO app;--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.purge_deleted_households(p_limit integer)
RETURNS SETOF uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $$
DECLARE
  v_org_id text;
  v_community_id text;
BEGIN
  v_org_id := current_setting('app.org_id', true);
  v_community_id := current_setting('app.community_id', true);

  IF v_org_id IS NULL OR v_org_id = '' OR v_community_id IS NULL OR v_community_id = '' THEN
    RAISE EXCEPTION 'tenant scope required';
  END IF;

  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 50 THEN
    RAISE EXCEPTION 'limit must be between 1 and 50';
  END IF;

  RETURN;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.purge_deleted_households(integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.purge_deleted_households(integer) TO app;--> statement-breakpoint
-- Recovery note: to withdraw database changes:
-- DROP FUNCTION app.purge_deleted_households(integer);
-- DROP TRIGGER households_before_insert ON app.households;
-- DROP FUNCTION app.households_before_insert();
-- DROP TRIGGER households_before_update ON app.households;
-- DROP FUNCTION app.households_before_update();
-- restore the 0022 bodies of app.persons_before_insert and app.persons_before_update;
-- REVOKE UPDATE (status, deleted_at, deleted_by, emergency_contacts) ON app.households FROM app;
