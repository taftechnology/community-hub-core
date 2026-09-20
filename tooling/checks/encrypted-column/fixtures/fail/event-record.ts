import { defineEvent } from "@community-hub/kernel/module";
import { z } from "zod";

export const event = defineEvent({
  name: "people.person.merged.v1",
  payload: z.record(z.string(), z.uuid()),
});
