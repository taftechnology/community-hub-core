import { z } from "zod";

export const payload = z.object({
  personId: z.uuid(),
});
