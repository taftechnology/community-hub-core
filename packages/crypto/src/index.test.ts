import { describe, expect, it } from "vitest";

import * as pub from "./index.js";

describe("public exports", () => {
  it("exports encrypt, decrypt, deriveKeys, generateAndWrap, and unwrapKey but not sealWith", () => {
    expect(pub.encrypt).toBeTypeOf("function");
    expect(pub.decrypt).toBeTypeOf("function");
    expect(pub.deriveKeys).toBeTypeOf("function");
    expect(pub.generateAndWrap).toBeTypeOf("function");
    expect(pub.unwrapKey).toBeTypeOf("function");
    expect(pub).not.toHaveProperty("sealWith");
    expect(pub).not.toHaveProperty("encodeAad");
    expect(pub).not.toHaveProperty("aes256GcmEncrypt");
  });
});
