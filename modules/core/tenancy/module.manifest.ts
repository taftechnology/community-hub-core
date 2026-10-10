import { defineModule } from "@community-hub/kernel/module";

export default defineModule({
  key: "core.tenancy",
  version: 1,
  requires: [],
  publishes: [],
  subscribes: [],
  ports: [],
  dataClasses: {
    "organisations.id": "internal",
    "organisations.slug": "internal",
    "organisations.region": "internal",
    "organisations.kind": "internal",
    "communities.id": "internal",
    "communities.organisation_id": "internal",
    "communities.slug": "internal",
    "communities.region": "internal",
  },
});
