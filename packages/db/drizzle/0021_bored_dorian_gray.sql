ALTER TABLE "app"."persons" ADD COLUMN "status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."persons" ADD COLUMN "source" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."persons" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."persons" ADD CONSTRAINT "persons_status_check" CHECK ("app"."persons"."status" in ('active', 'inactive'));--> statement-breakpoint
ALTER TABLE "app"."persons" ADD CONSTRAINT "persons_source_check" CHECK ("app"."persons"."source" in ('manual', 'family_records', 'website', 'form', 'donation', 'event_rsvp', 'event_booking', 'volunteer_application', 'mobile_app', 'mobile_app_family', 'auto'));--> statement-breakpoint
GRANT UPDATE (status, source) ON app.persons TO app;--> statement-breakpoint
-- Recovery note: the columns are new and nothing outside this chunk reads them.
DO $$
DECLARE
  c RECORD;
BEGIN
  FOR c IN SELECT id, organisation_id FROM platform.communities LOOP
    PERFORM set_config('app.org_id', c.organisation_id::text, true);
    PERFORM set_config('app.community_id', c.id::text, true);

    UPDATE app.persons p
    SET created_at = coalesce(
      (
        SELECT min(pa.occurred_at)
        FROM app.person_activity pa
        WHERE pa.org_id = c.organisation_id
          AND pa.community_id = c.id
          AND pa.person_id = p.id
          AND pa.kind = 'created'
      ),
      (
        SELECT min(pa.occurred_at)
        FROM app.person_activity pa
        WHERE pa.org_id = c.organisation_id
          AND pa.community_id = c.id
          AND pa.person_id = p.id
      ),
      now()
    )
    WHERE p.org_id = c.organisation_id
      AND p.community_id = c.id;
  END LOOP;
  PERFORM set_config('app.org_id', '', true);
  PERFORM set_config('app.community_id', '', true);
END $$;
