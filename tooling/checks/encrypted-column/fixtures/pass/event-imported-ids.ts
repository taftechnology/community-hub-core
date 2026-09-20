import { defineEvent } from "@community-hub/kernel/module";

import { payload } from "../event-schemas/ids.js";

export const event = defineEvent({
  name: "people.person.merged.v1",
  payload,
});
