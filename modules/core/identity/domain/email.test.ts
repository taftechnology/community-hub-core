import { describe, expect, it } from "vitest";

import { IdentityError } from "./error.js";
import { normaliseEmail } from "./email.js";

describe("normaliseEmail", () => {
  it("lowercases and trims ASCII spaces", () => {
    expect(normaliseEmail("Ada@Example.com")).toBe("ada@example.com");
    expect(normaliseEmail(" ada@example.com ")).toBe("ada@example.com");
    expect(normaliseEmail("ada@example.com")).toBe("ada@example.com");
  });

  it("rejects an address that is not local@domain", () => {
    const rejected = [
      "",
      "ada",
      "a da@example.com",
      "ada@@example.com",
      "ada@example",
      "ada@-example.com",
      "ada@example.com\n",
    ];
    for (const email of rejected) {
      expect(() => normaliseEmail(email)).toThrow(IdentityError);
      try {
        normaliseEmail(email);
      } catch (error) {
        expect(error).toBeInstanceOf(IdentityError);
        expect(error).toBeInstanceOf(Error);
        expect((error as IdentityError).code).toBe("invalid_email");
      }
    }
  });
});
