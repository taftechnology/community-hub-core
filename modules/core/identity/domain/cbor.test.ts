import { describe, expect, it } from "vitest";

import { decodeCbor, decodeCoseEc2, encodeCbor, type Cbor } from "./cbor.js";
import { IdentityError } from "./error.js";

describe("cbor", () => {
  it("round-trips the ceremony types", () => {
    const values: Cbor[] = [
      0,
      23,
      24,
      256,
      new Uint8Array([1, 2, 3]),
      "ada",
      [1, "ada", new Uint8Array([9])],
      new Map<Cbor, Cbor>([
        [1, "x"],
        ["k", 2],
      ]),
    ];
    for (const value of values) {
      expect(decodeCbor(encodeCbor(value))).toEqual(value);
    }
  });

  it("rejects a major type outside the ceremony set", () => {
    expect(() => decodeCbor(new Uint8Array([0xf5]))).toThrow(IdentityError);
    try {
      decodeCbor(new Uint8Array([0xf5]));
    } catch (error) {
      expect(error).toBeInstanceOf(IdentityError);
      expect(error).toMatchObject({ code: "invalid_ceremony" });
    }
  });

  it("accepts only an ES256 P-256 COSE key", () => {
    const x = new Uint8Array(32).fill(1);
    const y = new Uint8Array(32).fill(2);
    const key = encodeCbor(
      new Map<Cbor, Cbor>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, x],
        [-3, y],
      ]),
    );
    expect(decodeCoseEc2(key)).toEqual({ x, y });
    const wrongAlg = encodeCbor(
      new Map<Cbor, Cbor>([
        [1, 2],
        [3, -8],
        [-1, 1],
        [-2, x],
        [-3, y],
      ]),
    );
    expect(() => decodeCoseEc2(wrongAlg)).toThrow(IdentityError);
  });
});
