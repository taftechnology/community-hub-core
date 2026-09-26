import { describe, expect, it } from "vitest";

import {
  defineAuditAction,
  defineAuditPurpose,
  isAuditAction,
  isAuditPurpose,
} from "./audit-names";

describe("audit names", () => {
  it("rejects an action name with a version suffix", () => {
    expect(() => defineAuditAction("people.person.read.v1")).toThrow();
  });

  it("rejects a purpose name that does not match AUDIT_NAME_RE", () => {
    expect(() => defineAuditPurpose("ab")).toThrow();
  });

  it("defines a valid audit action", () => {
    const action = defineAuditAction("audit.chain.recorded");
    expect(action).toBe("audit.chain.recorded");
    expect(isAuditAction("audit.chain.recorded")).toBe(true);
  });

  it("does not treat a purpose-only name as an action", () => {
    const name = "audit.chain.purpose_only";
    defineAuditPurpose(name);
    expect(isAuditPurpose(name)).toBe(true);
    expect(isAuditAction(name)).toBe(false);

    defineAuditAction(name);
    expect(isAuditAction(name)).toBe(true);
  });

  it("reports purpose membership only after defineAuditPurpose", () => {
    expect(isAuditPurpose("audit.chain.test")).toBe(false);
    defineAuditPurpose("audit.chain.test");
    expect(isAuditPurpose("audit.chain.test")).toBe(true);
    expect(isAuditAction("audit.chain.test")).toBe(false);
  });
});
