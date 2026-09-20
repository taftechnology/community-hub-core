import { defineEvent } from "@community-hub/kernel/module";
import { z } from "zod";

const extra: Record<string, z.ZodType> = { otherId: z.uuid() };

export const event = defineEvent({
  name: "people.person.merged.v1",
  payload: z.object({ personId: z.uuid() }).extend(extra),
});
