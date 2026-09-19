import type { Ciphertext } from "@community-hub/crypto";
import { decrypt } from "@community-hub/crypto";
import { insertEncrypted } from "@community-hub/db";

import { db, emailBidx, payload, people } from "../../../../table.js";

declare const enc: CryptoKey;

export async function run(blob: Ciphertext): Promise<void> {
  await decrypt(blob, () => enc, {
    tag: "chub/field/v1",
    label: "people.email",
    rowId: new Uint8Array(16),
    communityId: new Uint8Array(16),
  });
  insertEncrypted(db, people, {
    id: "018f0000-0000-7000-8000-000000000001",
    payload,
    emailBidx,
  });
}
