import { addMember } from "@community-hub/access/testing";

export function leak(): unknown {
  return addMember;
}
