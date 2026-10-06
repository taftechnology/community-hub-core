import type { KmsPort } from "@community-hub/crypto";

export async function probe(port: KmsPort): Promise<void> {
  const generated = await port.generateDataKey("kms-id", {
    key_kind: "identity",
    region: "ap-southeast-2",
    key_version: "probe",
  });
  await port.decrypt("kms-id", generated.blob, {
    key_kind: "identity",
    region: "ap-southeast-2",
    key_version: "probe",
  });
}
