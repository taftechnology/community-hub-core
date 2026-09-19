import { describe, expect, it } from "vitest";

import { encodeAad, encodeLengthPrefixed } from "./aad.js";
import type { CommunityFieldAad, IdentityFieldAad } from "./aad.js";

const utf8 = (s: string) => new TextEncoder().encode(s);

describe("encodeLengthPrefixed", () => {
  it("distinguishes (ab,c) from (a,bc)", () => {
    const ab_c = encodeLengthPrefixed([utf8("ab"), utf8("c")]);
    const a_bc = encodeLengthPrefixed([utf8("a"), utf8("bc")]);
    expect(ab_c).not.toEqual(a_bc);
  });
});

describe("encodeAad", () => {
  const rowId = utf8("abcdefghijklmnop");
  const sixteen = utf8("abcdefghijklmnop");

  it("differs for community vs identity tags with the same remaining bytes", () => {
    const community: CommunityFieldAad = {
      tag: "chub/field/v1",
      label: "people.email",
      rowId,
      communityId: sixteen,
    };
    const identity: IdentityFieldAad = {
      tag: "chub/field-identity/v1",
      label: "people.email",
      rowId,
      region: "abcdefghijklmnop",
    };
    expect(encodeAad(community)).not.toEqual(encodeAad(identity));
  });

  it("rejects a label containing NUL", () => {
    expect(() =>
      encodeAad({
        tag: "chub/field/v1",
        label: "people\0email",
        rowId,
        communityId: sixteen,
      }),
    ).toThrow();
  });

  it("rejects a communityId that is not 16 bytes", () => {
    expect(() =>
      encodeAad({
        tag: "chub/field/v1",
        label: "people.email",
        rowId,
        communityId: new Uint8Array(0),
      }),
    ).toThrow();
  });
});
