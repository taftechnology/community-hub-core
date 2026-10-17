import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { applyProductMigrations, newId } from "@community-hub/db";
import { createPlaintextDirectSql, createPlaintextPlatformSql } from "@community-hub/db/plaintext";
import type { Sql } from "postgres";

import { currentSettings, insertSettings } from "./settings.js";

type Runtime = {
  productOnlyUrl: string;
  passwords: { platform: string };
};

const RUNTIME = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/db/test/.runtime.json",
);

function loadRuntime(): Runtime {
  return JSON.parse(readFileSync(RUNTIME, "utf8")) as Runtime;
}

function platformUrl(runtime: Runtime): string {
  const password = encodeURIComponent(runtime.passwords.platform);
  return `postgres://platform:${password}@127.0.0.1:5432/hub_product_only`;
}

let counter = 0;
function token(prefix: string): string {
  counter += 1;
  return `${prefix}_${counter}_${newId().replaceAll("-", "")}`;
}

describe("settings repository integration", () => {
  let platformSql: Sql;

  beforeAll(async () => {
    const runtime = loadRuntime();
    const migration = createPlaintextDirectSql(runtime.productOnlyUrl);
    try {
      await applyProductMigrations(migration);
    } finally {
      await migration.end({ timeout: 1 });
    }
    platformSql = createPlaintextPlatformSql(platformUrl(runtime));
  });

  afterAll(async () => {
    await platformSql.end({ timeout: 1 });
  });

  it("insertSettings rejects a null, undefined, or empty TaxRate id", async () => {
    await expect(
      insertSettings(platformSql, {
        gstRateBps: 1000,
        pricesIncludeGst: true,
        trialDays: 30,
        graceDays: 7,
        stripeTaxRateId: null as unknown as string,
        note: "no tax rate",
      }),
    ).rejects.toThrow();

    await expect(
      insertSettings(platformSql, {
        gstRateBps: 1000,
        pricesIncludeGst: true,
        trialDays: 30,
        graceDays: 7,
        stripeTaxRateId: "",
        note: "empty tax rate",
      }),
    ).rejects.toThrow();
  });

  it("the newest row wins by created_at, then by id", async () => {
    const baseTime = Date.now() + 100_000;
    const olderTime = new Date(baseTime + 10_000);
    const newerTime = new Date(baseTime + 20_000);

    const olderNote = token("older");
    const newerNote = token("newer");

    await insertSettings(platformSql, {
      gstRateBps: 1000,
      pricesIncludeGst: true,
      trialDays: 30,
      graceDays: 7,
      stripeTaxRateId: "txr_older",
      note: olderNote,
      createdAt: olderTime,
    });

    const insertedNewer = await insertSettings(platformSql, {
      gstRateBps: 1500,
      pricesIncludeGst: false,
      trialDays: 14,
      graceDays: 5,
      stripeTaxRateId: "txr_newer",
      note: newerNote,
      createdAt: newerTime,
    });

    const current = await currentSettings(platformSql);
    expect(current).not.toBeNull();
    expect(current?.id).toBe(insertedNewer.id);
    expect(current?.note).toBe(newerNote);
    expect(current?.gstRateBps).toBe(1500);
    expect(current?.pricesIncludeGst).toBe(false);
    expect(current?.trialDays).toBe(14);
    expect(current?.graceDays).toBe(5);
    expect(current?.stripeTaxRateId).toBe("txr_newer");

    // Test tie-breaking by id when created_at is identical
    const tieTime = new Date(baseTime + 30_000);
    const lowerId = "00000000-0000-0000-0000-000000000010";
    const higherId = "00000000-0000-0000-0000-000000000020";

    await insertSettings(platformSql, {
      id: lowerId,
      gstRateBps: 1000,
      pricesIncludeGst: true,
      trialDays: 30,
      graceDays: 7,
      stripeTaxRateId: "txr_tie_1",
      note: "tie lower id",
      createdAt: tieTime,
    });

    await insertSettings(platformSql, {
      id: higherId,
      gstRateBps: 1000,
      pricesIncludeGst: true,
      trialDays: 30,
      graceDays: 7,
      stripeTaxRateId: "txr_tie_2",
      note: "tie higher id",
      createdAt: tieTime,
    });

    const tieCurrent = await currentSettings(platformSql);
    expect(tieCurrent?.id).toBe(higherId);
    expect(tieCurrent?.note).toBe("tie higher id");
  });
});
