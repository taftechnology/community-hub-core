import { readContract } from "@community-hub/kms-broker";
import { describe, expect, it } from "vitest";

import { DECRYPT_PATH, GENERATE_DATA_KEY_PATH, KMS_LOGICAL_KEY_ID } from "./index.js";

describe("contract drift", () => {
  it("matches kms-port-v1.json routes and logical key id", () => {
    const contract = readContract();
    expect(KMS_LOGICAL_KEY_ID).toBe(contract.logicalKeyId);
    expect(contract.routes.generateDataKey).toEqual({
      method: "POST",
      path: GENERATE_DATA_KEY_PATH,
    });
    expect(contract.routes.decrypt).toEqual({
      method: "POST",
      path: DECRYPT_PATH,
    });
  });
});
