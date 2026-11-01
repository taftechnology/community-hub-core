ALTER TABLE "app"."households" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
GRANT UPDATE (label, version) ON app.households TO app;--> statement-breakpoint
GRANT UPDATE (household_id) ON app.persons TO app;--> statement-breakpoint
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
  RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.persons_before_update() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.persons_before_update() TO app;
--> statement-breakpoint
CREATE TRIGGER persons_before_update
  BEFORE UPDATE ON app.persons
  FOR EACH ROW
  EXECUTE FUNCTION app.persons_before_update();
