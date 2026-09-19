import type { Ciphertext } from "@community-hub/crypto";
import { decrypt } from "@community-hub/crypto";

import { db, people } from "../table.js";

declare const enc: CryptoKey;

type Row = { payload: Ciphertext };

export async function fromSelect(): Promise<Ciphertext | undefined> {
  const rows = await db.select({ payload: people.payload }).from(people);
  const ct = rows[0]?.payload ?? null;
  return ct ?? undefined;
}

export function passAlong(v: Ciphertext): { payload: Ciphertext } {
  const copy = v;
  return { payload: copy };
}

export const pick = (r: { payload: Ciphertext }) => r.payload;

export async function decryptHeld(rows: Row[]): Promise<void> {
  const ct = rows[0]?.payload;
  if (!ct) {
    return;
  }
  await decrypt(ct, () => enc, {
    tag: "chub/field/v1",
    label: "people.email",
    rowId: new Uint8Array(16),
    communityId: new Uint8Array(16),
  });
}
