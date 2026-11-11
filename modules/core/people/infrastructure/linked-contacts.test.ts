import type { KmsPort } from "@community-hub/crypto";
import { newId, type AppTransaction } from "@community-hub/db";
import { describe, expect, it } from "vitest";

import { PeopleError } from "../domain/error.js";
import { readLinkedContacts } from "./linked-contacts.js";

describe("readLinkedContacts unit", () => {
  const dummyKms: KmsPort = {
    generateDataKey: async () => {
      throw new Error("unexpected generateDataKey call");
    },
    decrypt: async () => {
      throw new Error("unexpected decrypt call");
    },
  };
  const dummyTx = (() => {
    throw new Error("unexpected tx call");
  }) as unknown as AppTransaction;
  const keyArn = "arn:aws:kms:ap-southeast-2:123456789012:key/test";
  const validActorId = newId();

  it("an empty input returns an empty map with no SQL and no KMS call", async () => {
    const result = await readLinkedContacts(dummyTx, dummyKms, keyArn, {
      personIds: [],
      includePhone: false,
      actorUserId: validActorId,
    });
    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(0);
  });

  it("throws PeopleError with code invalid_input for non-UUID strings", async () => {
    const invalidBatches: string[][] = [
      ["not-a-uuid"],
      ["12345"],
      ["00000000-0000-0000-0000-00000000000z"],
      ["00000000000000000000000000000000"],
      [""],
    ];
    for (const invalidBatch of invalidBatches) {
      await expect(
        readLinkedContacts(dummyTx, dummyKms, keyArn, {
          personIds: invalidBatch,
          includePhone: false,
          actorUserId: validActorId,
        }),
      ).rejects.toThrow(new PeopleError("invalid_input"));
    }
  });

  it("rejects a bad id after a good one with PeopleError invalid_input", async () => {
    const goodId = newId();
    await expect(
      readLinkedContacts(dummyTx, dummyKms, keyArn, {
        personIds: [goodId, "not-a-uuid"],
        includePhone: false,
        actorUserId: validActorId,
      }),
    ).rejects.toThrow(new PeopleError("invalid_input"));
  });

  it("throws PeopleError with code invalid_input for non-UUID actorUserId", async () => {
    await expect(
      readLinkedContacts(dummyTx, dummyKms, keyArn, {
        personIds: [newId()],
        includePhone: false,
        actorUserId: "invalid-actor-uuid",
      }),
    ).rejects.toThrow(new PeopleError("invalid_input"));
  });

  it("throws PeopleError with code invalid_input when more than 500 ids are provided", async () => {
    const ids = Array.from({ length: 501 }, () => newId());
    await expect(
      readLinkedContacts(dummyTx, dummyKms, keyArn, {
        personIds: ids,
        includePhone: false,
        actorUserId: validActorId,
      }),
    ).rejects.toThrow(new PeopleError("invalid_input"));
  });

  it("accepts exactly 500 ids and shows that they reach the database", async () => {
    const ids = Array.from({ length: 500 }, () => newId());
    await expect(
      readLinkedContacts(dummyTx, dummyKms, keyArn, {
        personIds: ids,
        includePhone: false,
        actorUserId: validActorId,
      }),
    ).rejects.toThrow("unexpected tx call");
  });

  it("the SQL text names phone only between select and from (pin 13)", async () => {
    const queries: string[] = [];
    const fakeTx = ((strings: TemplateStringsArray) => {
      const text = strings.reduce((acc, str, i) => acc + "$" + i + str);
      queries.push(text);
      return Promise.resolve([]);
    }) as unknown as AppTransaction;

    await readLinkedContacts(fakeTx, dummyKms, keyArn, {
      personIds: [newId()],
      includePhone: false,
      actorUserId: validActorId,
    });

    const personsQuery = queries.find((q) => q.includes("app.persons"));
    expect(personsQuery).toBeDefined();

    // Check that phone is named between select and from
    const selectFromMatch = personsQuery!.match(/select\s+(.*?)\s+from/is);
    expect(selectFromMatch).toBeTruthy();
    expect(selectFromMatch![1]).toMatch(/\bphone\b/);

    // Check that phone is NOT named anywhere outside select ... from
    const outside = personsQuery!.replace(/select\s+.*?\s+from/is, "");
    expect(outside).not.toMatch(/\bphone\b/);
  });

  it("the SQL text names no household_id and no _restricted column", async () => {
    const queries: string[] = [];
    const fakeTx = ((strings: TemplateStringsArray) => {
      const text = strings.reduce((acc, str, i) => acc + "$" + i + str);
      queries.push(text);
      return Promise.resolve([]);
    }) as unknown as AppTransaction;

    await readLinkedContacts(fakeTx, dummyKms, keyArn, {
      personIds: [newId()],
      includePhone: false,
      actorUserId: validActorId,
    });

    const personsQuery = queries.find((q) => q.includes("app.persons"));
    expect(personsQuery).toBeDefined();
    expect(personsQuery).not.toMatch(/\bhousehold_id\b/i);
    expect(personsQuery).not.toMatch(/_restricted/i);
  });

  it("the SQL text holds both predicates, org_id = current_setting('app.org_id') and community_id = current_setting('app.community_id') (pin 14 (a))", async () => {
    const queries: string[] = [];
    const fakeTx = ((strings: TemplateStringsArray) => {
      const text = strings.reduce((acc, str, i) => acc + "$" + i + str);
      queries.push(text);
      return Promise.resolve([]);
    }) as unknown as AppTransaction;

    await readLinkedContacts(fakeTx, dummyKms, keyArn, {
      personIds: [newId()],
      includePhone: false,
      actorUserId: validActorId,
    });

    const personsQuery = queries.find((q) => q.includes("app.persons"));
    expect(personsQuery).toBeDefined();

    expect(personsQuery).toMatch(/org_id\s*=\s*current_setting\(\s*'app\.org_id'\s*\)/);
    expect(personsQuery).toMatch(/community_id\s*=\s*current_setting\(\s*'app\.community_id'\s*\)/);
  });
});
