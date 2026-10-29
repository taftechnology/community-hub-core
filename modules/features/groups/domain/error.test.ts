import { describe, expect, it } from "vitest";

import { GroupsError, type GroupsErrorCode } from "./error.js";

describe("GroupsError", () => {
  it("carries the error code only in the message (pin 28)", () => {
    const codes: GroupsErrorCode[] = [
      "duplicate_name",
      "already_member",
      "person_not_found",
      "group_not_found",
      "group_archived",
      "invalid_input",
    ];

    for (const code of codes) {
      const error = new GroupsError(code);
      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe("GroupsError");
      expect(error.code).toBe(code);
      expect(error.message).toBe(code);
    }
  });

  it("does not leak extra context or names in error message", () => {
    const error = new GroupsError("duplicate_name");
    expect(error.message).toBe("duplicate_name");
    expect(error.message).not.toContain("group");
  });
});
