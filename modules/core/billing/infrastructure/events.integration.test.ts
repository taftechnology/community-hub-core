import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { applyProductMigrations, newId } from "@community-hub/db";
import { createPlaintextDirectSql, createPlaintextPlatformSql } from "@community-hub/db/plaintext";
import type { Sql } from "postgres";

import { isReplayOutcome, markOutcome, recordReceived } from "./events.js";

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

describe("events repository integration", () => {
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

  it("first recordReceived returns received, stores row with null processed_at", async () => {
    const eventId = token("evt");
    const eventType = "checkout.session.completed";

    const outcome = await recordReceived(platformSql, eventId, eventType);
    expect(outcome).toBe("received");

    const rows = await platformSql<
      { event_id: string; type: string; outcome: string; processed_at: Date | null }[]
    >`
      select event_id, type, outcome, processed_at
      from platform.billing_stripe_events
      where event_id = ${eventId}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.outcome).toBe("received");
    expect(rows[0]?.type).toBe(eventType);
    expect(rows[0]?.processed_at).toBeNull();
  });

  it("a received row stays received on repeated recordReceived calls", async () => {
    const eventId = token("evt");
    const eventType = "customer.subscription.updated";

    const first = await recordReceived(platformSql, eventId, eventType);
    expect(first).toBe("received");

    const second = await recordReceived(platformSql, eventId, eventType);
    expect(second).toBe("received");

    const rows = await platformSql<{ outcome: string }[]>`
      select outcome
      from platform.billing_stripe_events
      where event_id = ${eventId}
    `;
    expect(rows[0]?.outcome).toBe("received");
  });

  it("after markOutcome(processed), recordReceived returns processed and sets processed_at", async () => {
    const eventId = token("evt");
    const eventType = "invoice.paid";

    await recordReceived(platformSql, eventId, eventType);
    await markOutcome(platformSql, eventId, "processed");

    const rows = await platformSql<{ outcome: string; processed_at: Date | null }[]>`
      select outcome, processed_at
      from platform.billing_stripe_events
      where event_id = ${eventId}
    `;
    expect(rows[0]?.outcome).toBe("processed");
    expect(rows[0]?.processed_at).toBeInstanceOf(Date);

    const replayed = await recordReceived(platformSql, eventId, eventType);
    expect(replayed).toBe("processed");
  });

  it("after markOutcome(ignored), recordReceived returns ignored and sets processed_at", async () => {
    const eventId = token("evt");
    const eventType = "unknown.event.type";

    await recordReceived(platformSql, eventId, eventType);
    await markOutcome(platformSql, eventId, "ignored");

    const rows = await platformSql<{ outcome: string; processed_at: Date | null }[]>`
      select outcome, processed_at
      from platform.billing_stripe_events
      where event_id = ${eventId}
    `;
    expect(rows[0]?.outcome).toBe("ignored");
    expect(rows[0]?.processed_at).toBeInstanceOf(Date);

    const replayed = await recordReceived(platformSql, eventId, eventType);
    expect(replayed).toBe("ignored");
  });

  it("pin 10: event replay short-circuits only processed and ignored, received is not short-circuited", async () => {
    expect(isReplayOutcome("processed")).toBe(true);
    expect(isReplayOutcome("ignored")).toBe(true);
    expect(isReplayOutcome("received")).toBe(false);

    const eventId = token("evt");
    const initial = await recordReceived(platformSql, eventId, "customer.subscription.created");
    expect(isReplayOutcome(initial)).toBe(false);

    await markOutcome(platformSql, eventId, "processed");
    const processedOutcome = await recordReceived(
      platformSql,
      eventId,
      "customer.subscription.created",
    );
    expect(isReplayOutcome(processedOutcome)).toBe(true);
  });
});
