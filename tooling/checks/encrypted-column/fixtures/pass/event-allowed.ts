import { defineEvent } from "@community-hub/kernel/module";
import { z } from "zod";

export const event = defineEvent({
  name: "people.person.merged.v1",
  payload: z.object({
    personId: z.uuid(),
    status: z.enum(["merged", "split"]),
    dryRun: z.boolean(),
    version: z.int(),
    occurredAt: z.iso.datetime(),
  }),
});
