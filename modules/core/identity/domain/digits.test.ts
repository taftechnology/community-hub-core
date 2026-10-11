import { describe, expect, it } from "vitest";

import { digitFromByte, eightDigitsFrom } from "./digits.js";

describe("one-time code digits", () => {
  it("rejects bytes that would bias a decimal digit", () => {
    expect(digitFromByte(0)).toBe("0");
    expect(digitFromByte(9)).toBe("9");
    expect(digitFromByte(249)).toBe("9");
    expect(digitFromByte(250)).toBeNull();
    expect(digitFromByte(255)).toBeNull();
  });

  it("skips rejected bytes until eight digits are filled", () => {
    const source = [250, 255, 249, 0, 10, 21, 32, 43, 54, 65];
    let index = 0;
    const code = eightDigitsFrom((bytes) => {
      for (let offset = 0; offset < bytes.length; offset += 1) {
        bytes[offset] = source[index] ?? 1;
        index += 1;
      }
    });
    expect(code).toBe("90012345");
  });
});
