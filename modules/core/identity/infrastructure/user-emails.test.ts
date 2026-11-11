import type { KmsPort } from "@community-hub/crypto";
import { newId } from "@community-hub/db";
import type { Sql } from "postgres";
import { describe, expect, it } from "vitest";

import { IdentityError } from "../domain/error.js";
import { readUserEmails } from "./user-emails.js";

describe("readUserEmails unit", () => {
  const dummyKms: KmsPort = {
    generateDataKey: async () => {
      throw new Error("unexpected generateDataKey call");
    },
    decrypt: async () => {
      throw new Error("unexpected decrypt call");
    },
  };
  const dummySql = (() => {
    throw new Error("unexpected sql call");
  }) as unknown as Sql;
  const keyArn = "arn:aws:kms:ap-southeast-2:123456789012:key/test";

  it("an empty input makes no SQL call and no KMS call", async () => {
    const result = await readUserEmails(dummySql, dummyKms, keyArn, []);
    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(0);
  });

  it("throws IdentityError with code invalid_input for non-UUID strings", async () => {
    const invalidIds = [
      "not-a-uuid",
      "12345",
      "00000000-0000-0000-0000-00000000000z",
      "00000000000000000000000000000000",
      "",
    ];
    for (const invalidId of invalidIds) {
      await expect(readUserEmails(dummySql, dummyKms, keyArn, [invalidId])).rejects.toThrow(
        new IdentityError("invalid_input"),
      );
    }
  });

  it("throws IdentityError with code invalid_input when more than 500 ids are provided", async () => {
    const ids = Array.from({ length: 501 }, () => newId());
    await expect(readUserEmails(dummySql, dummyKms, keyArn, ids)).rejects.toThrow(
      new IdentityError("invalid_input"),
    );
  });

  it("the SQL text names email only between select and from (pin 13)", async () => {
    const queries: string[] = [];
    const fakeSql = ((strings: TemplateStringsArray) => {
      const text = strings.reduce((acc, str, i) => acc + "$" + i + str);
      queries.push(text);
      if (queries.length === 1) {
        // First query: select id, wrapped from identity.identity_keys
        return Promise.resolve([
          { id: "00000000-0000-0000-0000-000000000001", wrapped: new Uint8Array(32) },
        ]);
      }
      // Second query: select id, email from identity.users
      return Promise.resolve([]);
    }) as unknown as Sql;

    const fakeKms: KmsPort = {
      generateDataKey: async () => {
        throw new Error("unexpected generateDataKey call");
      },
      decrypt: async () => new Uint8Array(32),
    };

    await readUserEmails(fakeSql, fakeKms, keyArn, [newId()]);

    const usersQuery = queries.find((q) => q.includes("identity.users"));
    expect(usersQuery).toBeDefined();

    // Check that email is named between select and from
    const selectFromMatch = usersQuery!.match(/select\s+(.*?)\s+from/is);
    expect(selectFromMatch).toBeTruthy();
    expect(selectFromMatch![1]).toMatch(/\bemail\b/);

    // Check that email is NOT named anywhere outside select ... from
    const outside = usersQuery!.replace(/select\s+.*?\s+from/is, "");
    expect(outside).not.toMatch(/\bemail\b/);
  });
});
