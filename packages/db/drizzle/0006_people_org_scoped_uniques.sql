ALTER TABLE "app"."community_keys" DROP CONSTRAINT "community_keys_community_id_unique";--> statement-breakpoint
ALTER TABLE "app"."person_tags" DROP CONSTRAINT "person_tags_community_label_unique";--> statement-breakpoint
ALTER TABLE "app"."community_keys" ADD CONSTRAINT "community_keys_community_id_unique" UNIQUE("org_id","community_id");--> statement-breakpoint
ALTER TABLE "app"."person_tags" ADD CONSTRAINT "person_tags_community_label_unique" UNIQUE("org_id","community_id","label");