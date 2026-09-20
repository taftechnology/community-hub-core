import { defineEvent } from "@community-hub/kernel/module";
import { z } from "zod";

export const event = defineEvent({
  name: "not-an-event",
  payload: z.object({
    personId: z.uuid(),
  }),
});
