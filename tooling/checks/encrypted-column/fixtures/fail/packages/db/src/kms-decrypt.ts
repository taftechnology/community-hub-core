import type { KmsPort } from "@community-hub/crypto";

export async function leak(port: KmsPort): Promise<Uint8Array> {
  return port.decrypt("kms-id", new Uint8Array(), {
    key_kind: "org",
    org_id: "org-synthetic",
    key_version: "v1",
  });
}
