import { healthPayload } from "@community-hub/kernel";

export function ping(): { ok: true } {
  return healthPayload();
}
