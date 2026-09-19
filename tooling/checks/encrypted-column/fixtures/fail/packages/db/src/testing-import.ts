import { createLocalKmsPort } from "@community-hub/crypto/testing";

export function leak(): unknown {
  return createLocalKmsPort();
}
