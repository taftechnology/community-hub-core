import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { buildInvitationToken, parseInvitationToken } from "./invitation-token.js";

const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

describe("invitation token (pin 29)", () => {
  const orgId = "11111111-1111-4111-8111-111111111111";
  const communityId = "22222222-2222-4222-8222-222222222222";
  const invitationId = "33333333-3333-4333-8333-333333333333";
  const nilUuid = "00000000-0000-0000-0000-000000000000";

  it("round trips returning the three ids and secret, and tokenHash is SHA-256 of secret", () => {
    const { token, tokenHash } = buildInvitationToken({
      orgId,
      communityId,
      invitationId,
    });

    expect(token).toMatch(/^v1\.[A-Za-z0-9_-]{107}$/);

    const parsed = parseInvitationToken(token);
    expect(parsed).not.toBe("invalid");
    if (parsed === "invalid") {
      throw new Error("expected valid token");
    }

    expect(parsed.orgId).toBe(orgId);
    expect(parsed.communityId).toBe(communityId);
    expect(parsed.invitationId).toBe(invitationId);
    expect(parsed.secret).toHaveLength(32);

    const expectedHash = createHash("sha256").update(parsed.secret).digest();
    expect(Buffer.from(tokenHash).equals(expectedHash)).toBe(true);
  });

  it("parses to invalid for wrong prefix, wrong lengths, inserted character, non-canonical character, and nil uuid", () => {
    const { token } = buildInvitationToken({
      orgId,
      communityId,
      invitationId,
    });

    // wrong prefix
    expect(parseInvitationToken("v2." + token.slice(3))).toBe("invalid");
    expect(parseInvitationToken("x1." + token.slice(3))).toBe("invalid");
    expect(parseInvitationToken(token.slice(3))).toBe("invalid");

    // 106 characters payload (109 total)
    expect(parseInvitationToken(token.slice(0, -1))).toBe("invalid");

    // 108 characters payload (111 total)
    expect(parseInvitationToken(token + "A")).toBe("invalid");

    // a ! inserted
    const withExclamation = token.slice(0, 10) + "!" + token.slice(11);
    expect(parseInvitationToken(withExclamation)).toBe("invalid");

    // non-canonical last character
    const lastChar = token[token.length - 1]!;
    const lastCharIdx = BASE64URL.indexOf(lastChar);
    expect(lastCharIdx).toBeGreaterThanOrEqual(0);
    // In base64url encoding 80 bytes (640 bits), the 107th char encodes bits 636..639.
    // Bits 640..641 (the lowest 2 bits) must be 0.
    // Flipping the lowest bit produces a non-canonical character that decodes to the same bytes.
    const nonCanonicalIdx = lastCharIdx ^ 1;
    const nonCanonicalToken = token.slice(0, -1) + BASE64URL[nonCanonicalIdx]!;
    expect(parseInvitationToken(nonCanonicalToken)).toBe("invalid");

    // nil uuid in orgId
    const nilOrgToken = buildInvitationToken({
      orgId: nilUuid,
      communityId,
      invitationId,
    });
    expect(parseInvitationToken(nilOrgToken.token)).toBe("invalid");

    // nil uuid in communityId
    const nilCommToken = buildInvitationToken({
      orgId,
      communityId: nilUuid,
      invitationId,
    });
    expect(parseInvitationToken(nilCommToken.token)).toBe("invalid");

    // nil uuid in invitationId
    const nilInvToken = buildInvitationToken({
      orgId,
      communityId,
      invitationId: nilUuid,
    });
    expect(parseInvitationToken(nilInvToken.token)).toBe("invalid");
  });
});
