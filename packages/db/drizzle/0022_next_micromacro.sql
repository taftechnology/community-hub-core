ALTER TABLE "app"."custom_role_permissions" DROP CONSTRAINT "custom_role_permissions_permission";--> statement-breakpoint
ALTER TABLE "app"."persons" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app"."persons" ADD COLUMN "deleted_by" uuid;--> statement-breakpoint
CREATE INDEX "persons_deleted_idx" ON "app"."persons" USING btree ("org_id","community_id","deleted_at") WHERE "app"."persons"."deleted_at" is not null;--> statement-breakpoint
ALTER TABLE "app"."custom_role_permissions" ADD CONSTRAINT "custom_role_permissions_permission" CHECK ("app"."custom_role_permissions"."permission" in ('access.users.view', 'access.users.manage', 'access.roles.view', 'access.roles.manage', 'people.view', 'people.manage', 'people.restricted.read', 'entitlements.view', 'entitlements.manage', 'service_times.manage', 'people.delete'));--> statement-breakpoint
GRANT UPDATE (deleted_at, deleted_by) ON app.persons TO app;--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.persons_before_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, app
AS $$
BEGIN
  IF OLD.is_minor AND NEW.household_id IS DISTINCT FROM OLD.household_id THEN
    RAISE EXCEPTION 'cannot change household of a minor';
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
GRANT EXECUTE ON FUNCTION app.persons_before_update() TO app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.persons_before_insert()
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
REVOKE ALL ON FUNCTION app.persons_before_insert() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.persons_before_insert() TO app;
--> statement-breakpoint
CREATE TRIGGER persons_before_insert
  BEFORE INSERT ON app.persons
  FOR EACH ROW
  EXECUTE FUNCTION app.persons_before_insert();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.purge_deleted_persons(p_limit integer)
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
REVOKE ALL ON FUNCTION app.purge_deleted_persons(integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.purge_deleted_persons(integer) TO app;
--> statement-breakpoint
-- Recovery note: to withdraw database changes:
-- DROP FUNCTION app.purge_deleted_persons(integer);
-- DROP TRIGGER persons_before_insert ON app.persons;
-- DROP FUNCTION app.persons_before_insert();
-- restore the 0016 body of app.persons_before_update;
-- REVOKE UPDATE (deleted_at, deleted_by) ON app.persons FROM app;
-- delete custom_role_permissions rows with people.delete before re-adding the ten-key CHECK.
