CREATE TABLE "platform"."communities" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"region" text NOT NULL,
	CONSTRAINT "communities_slug_unique" UNIQUE("slug"),
	CONSTRAINT "communities_region_au" CHECK ("platform"."communities"."region" = 'au'),
	CONSTRAINT "communities_slug_label" CHECK ("platform"."communities"."slug" ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$')
);
--> statement-breakpoint
CREATE TABLE "platform"."organisations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"region" text NOT NULL,
	"kind" text NOT NULL,
	CONSTRAINT "organisations_slug_unique" UNIQUE("slug"),
	CONSTRAINT "organisations_region_au" CHECK ("platform"."organisations"."region" = 'au'),
	CONSTRAINT "organisations_kind" CHECK ("platform"."organisations"."kind" in ('implicit', 'explicit')),
	CONSTRAINT "organisations_slug_label" CHECK ("platform"."organisations"."slug" ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$')
);
--> statement-breakpoint
ALTER TABLE "platform"."communities" ADD CONSTRAINT "communities_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "platform"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "communities_organisation_id_idx" ON "platform"."communities" USING btree ("organisation_id");