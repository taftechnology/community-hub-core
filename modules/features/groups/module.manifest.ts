import { defineModule } from "@community-hub/kernel/module";

export default defineModule({
  key: "groups",
  version: 1,
  requires: ["core.people", "core.usage"],
  publishes: [],
  subscribes: [],
  ports: [],
  features: ["groups.basic"],
  permissions: ["groups.manage", "groups.export"],
  dataClasses: {},
});
