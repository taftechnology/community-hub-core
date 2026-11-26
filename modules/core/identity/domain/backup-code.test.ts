import { describe, expect, it } from "vitest";

import { formatBackupCode, newBackupCodes, normaliseBackupCode } from "./backup-code.js";

describe("backup codes", () => {
  it("makes ten twelve-character base32 codes", () => {
    const first = newBackupCodes();
    const second = newBackupCodes();

    expect(first).toHaveLength(10);
    for (const code of first) {
      expect(code).toMatch(/^[A-Z2-7]{12}$/);
    }
    expect(new Set(first).size).toBe(10);
    expect(second).toHaveLength(10);
    expect(second).not.toEqual(first);
  });

  it("accepts lower case, spaces and dashes", () => {
    expect(normaliseBackupCode("abcd efgh-ijkl")).toBe("ABCDEFGHIJKL");
    expect(normaliseBackupCode(" 2345-67ab-cdef ")).toBe("234567ABCDEF");
    expect(normaliseBackupCode("ABCDEFGHIJKL")).toBe("ABCDEFGHIJKL");

    const generated = newBackupCodes();
    for (const code of generated) {
      const formatted = `${code.slice(0, 4).toLowerCase()} ${code.slice(4, 8).toLowerCase()}-${code.slice(8, 12).toLowerCase()}`;
      expect(normaliseBackupCode(formatted)).toBe(code);
    }

    expect(normaliseBackupCode("")).toBeNull();
    expect(normaliseBackupCode("   --  ")).toBeNull();
    expect(normaliseBackupCode("ABCDEFGHIJK")).toBeNull();
    expect(normaliseBackupCode("ABCDEFGHIJKLM")).toBeNull();
    expect(normaliseBackupCode("0BCDEFGHIJKL")).toBeNull();
    expect(normaliseBackupCode("1BCDEFGHIJKL")).toBeNull();
    expect(normaliseBackupCode("8BCDEFGHIJKL")).toBeNull();
    expect(normaliseBackupCode("9BCDEFGHIJKL")).toBeNull();
    expect(normaliseBackupCode("ABCDEFGHIJK=")).toBeNull();
    expect(normaliseBackupCode("ABCDEFGHIJK_")).toBeNull();
    expect(normaliseBackupCode("ABCD\tEFGHIJKL")).toBeNull();
    expect(normaliseBackupCode("\u00a0ABCDEFGHIJKL")).toBeNull();
    expect(normaliseBackupCode("ßABCDEFGHIJ")).toBeNull();
    expect(normaliseBackupCode("ıBCDEFGHIJKL")).toBeNull();
    expect(normaliseBackupCode("ſBCDEFGHIJKL")).toBeNull();
    expect(normaliseBackupCode("ﬁABCDEFGHIJ")).toBeNull();
  });

  it("refuses codes with 0, 1, 8 or 9 and other characters outside base32", () => {
    expect(normaliseBackupCode("0BCDEFGHIJKL")).toBeNull();
    expect(normaliseBackupCode("A1CDEFGHIJKL")).toBeNull();
    expect(normaliseBackupCode("ABCDE8GHIJKL")).toBeNull();
    expect(normaliseBackupCode("ABCDEFGHIJK9")).toBeNull();
    expect(normaliseBackupCode("0189 0189 0189")).toBeNull();
    expect(normaliseBackupCode("0189-AAAA-AAAA")).toBeNull();
    expect(normaliseBackupCode("ABCDEFGHIJK=")).toBeNull();
    expect(normaliseBackupCode("ABCDEFGHIJK_")).toBeNull();
    expect(normaliseBackupCode("ABCD+EFGHIJK")).toBeNull();
    expect(normaliseBackupCode("ABCD/EFGHIJK")).toBeNull();
    expect(normaliseBackupCode("ABCD!EFGHIJK")).toBeNull();
    expect(normaliseBackupCode("ABCD\tEFGHIJKL")).toBeNull();
    expect(normaliseBackupCode("ABCD\nEFGHIJKL")).toBeNull();
    expect(normaliseBackupCode("\u00a0ABCDEFGHIJKL")).toBeNull();
    expect(normaliseBackupCode("ßABCDEFGHIJ")).toBeNull();
    expect(normaliseBackupCode("ıBCDEFGHIJKL")).toBeNull();
    expect(normaliseBackupCode("ſBCDEFGHIJKL")).toBeNull();
    expect(normaliseBackupCode("ﬁABCDEFGHIJ")).toBeNull();
    expect(normaliseBackupCode("ÄBCDEFGHIJKL")).toBeNull();
    expect(normaliseBackupCode("")).toBeNull();
    expect(normaliseBackupCode("   --  ")).toBeNull();
    expect(normaliseBackupCode("ABCDEFGHIJK")).toBeNull();
    expect(normaliseBackupCode("ABCDEFGHIJKLM")).toBeNull();
  });

  it("formats a backup code in groups of four separated by spaces", () => {
    expect(formatBackupCode("ABCDEFGHIJKL")).toBe("ABCD EFGH IJKL");
    expect(formatBackupCode("abcd efgh-ijkl")).toBe("ABCD EFGH IJKL");

    for (const code of newBackupCodes()) {
      const formatted = formatBackupCode(code);
      expect(formatted).toMatch(/^[A-Z2-7]{4} [A-Z2-7]{4} [A-Z2-7]{4}$/);
      expect(normaliseBackupCode(formatted)).toBe(code);
    }
  });
});
