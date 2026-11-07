import { defineModule } from "@community-hub/kernel/module";

export default defineModule({
  key: "engagement",
  version: 1,
  requires: ["core.usage"],
  publishes: [],
  subscribes: [],
  ports: [],
  features: ["module.engagement"],
  permissions: ["service_times.manage"],
  website: { collections: ["engagement.service_times"] },
  dataClasses: {
    "service_times.org_id": "internal",
    "service_times.community_id": "internal",
    "service_times.content_html": "public",
    "service_times.version": "internal",
    "service_times.created_at": "internal",
    "service_times.updated_at": "internal",
  },
});
