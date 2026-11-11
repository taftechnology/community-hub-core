import { describe, expect, it } from "vitest";
import { isAuditAction, isAuditPurpose } from "@community-hub/kernel/module";

import type { AccessErrorCode } from "../domain/error.js";
import { AccessError } from "../public/index.js";

describe("audit registration", () => {
  it("registers users listed action and purpose and users view purpose", () => {
    expect(isAuditAction("access.users.listed")).toBe(true);
    expect(isAuditPurpose("access.users.listed")).toBe(true);
    expect(isAuditPurpose("access.users.view")).toBe(true);
  });

  it("includes too_many in AccessErrorCode", () => {
    const code: AccessErrorCode = "too_many";
    const error = new AccessError(code);
    expect(error.code).toBe("too_many");
  });
});
