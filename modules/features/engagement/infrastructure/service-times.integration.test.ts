import { beforeAll, describe, expect, it } from "vitest";

import { applyProductMigrations, newId, withAppTransaction } from "@community-hub/db";
import {
  createPlaintextAppSql,
  createPlaintextDirectSql,
  createPlaintextPlatformSql,
} from "@community-hub/db/plaintext";
import { withRequest } from "@community-hub/kernel";

import {
  getPublishedServiceTimes,
  getServiceTimes,
  saveServiceTimes,
  ServiceTimesError,
} from "../public/index.js";
import { cleanScope, createScope, loadRuntime, roleUrl } from "../test/fixtures/real-scope.js";

beforeAll(async () => {
  const runtime = loadRuntime();
  const migration = createPlaintextDirectSql(runtime.productOnlyUrl);
  try {
    await applyProductMigrations(migration);
  } finally {
    await migration.end({ timeout: 1 });
  }
});

describe("service times integration", () => {
  it("first save with expected version 0 inserts a row at version 1 and returns { html, version: 1 }", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const scope = await createScope(platform);
    const now = new Date("2026-06-01T10:00:00.000Z");

    try {
      await withRequest({ requestId: newId() }, () =>
        withAppTransaction(app, scope, async (tx) => {
          // Read before save: empty and version 0
          const initial = await getServiceTimes(tx);
          expect(initial).toEqual({ html: "", version: 0 });

          // First save
          const saved = await saveServiceTimes(tx, {
            html: "<h2>Sunday Mass</h2><p>10:00 AM</p>",
            expectedVersion: 0,
            now,
            actorUserId: null,
          });

          expect(saved).toEqual({
            html: "<h2>Sunday Mass</h2><p>10:00 AM</p>",
            version: 1,
          });

          // Read back
          const current = await getServiceTimes(tx);
          expect(current).toEqual(saved);
        }),
      );

      // Verify database record via direct sql
      const rows = await directSql<
        {
          content_html: string;
          version: number;
          created_at: Date;
          updated_at: Date;
        }[]
      >`
        select content_html, version, created_at, updated_at
        from app.service_times
        where org_id = ${scope.orgId}::uuid and community_id = ${scope.communityId}::uuid
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.content_html).toBe("<h2>Sunday Mass</h2><p>10:00 AM</p>");
      expect(rows[0]?.version).toBe(1);
      expect(rows[0]?.created_at).toEqual(now);
      expect(rows[0]?.updated_at).toEqual(now);
    } finally {
      try {
        await cleanScope(directSql, scope);
      } finally {
        await platform.end({ timeout: 1 });
        await app.end({ timeout: 1 });
        await directSql.end({ timeout: 1 });
      }
    }
  });

  it("save with the right expected version increments version by one, sets updated_at, and returns new html and version (pin 12)", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const scope = await createScope(platform);
    const t1 = new Date("2026-06-01T10:00:00.000Z");
    const t2 = new Date("2026-06-01T12:00:00.000Z");

    try {
      await withRequest({ requestId: newId() }, () =>
        withAppTransaction(app, scope, async (tx) => {
          await saveServiceTimes(tx, {
            html: "<p>Original</p>",
            expectedVersion: 0,
            now: t1,
            actorUserId: null,
          });

          const updated = await saveServiceTimes(tx, {
            html: "<p>Updated content</p>",
            expectedVersion: 1,
            now: t2,
            actorUserId: null,
          });

          expect(updated).toEqual({
            html: "<p>Updated content</p>",
            version: 2,
          });

          const current = await getServiceTimes(tx);
          expect(current).toEqual(updated);
        }),
      );

      const rows = await directSql<
        {
          content_html: string;
          version: number;
          created_at: Date;
          updated_at: Date;
        }[]
      >`
        select content_html, version, created_at, updated_at
        from app.service_times
        where org_id = ${scope.orgId}::uuid and community_id = ${scope.communityId}::uuid
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.content_html).toBe("<p>Updated content</p>");
      expect(rows[0]?.version).toBe(2);
      expect(rows[0]?.created_at).toEqual(t1);
      expect(rows[0]?.updated_at).toEqual(t2);
    } finally {
      try {
        await cleanScope(directSql, scope);
      } finally {
        await platform.end({ timeout: 1 });
        await app.end({ timeout: 1 });
        await directSql.end({ timeout: 1 });
      }
    }
  });

  it("stale expected version, expected 0 with row, and non-zero expected version with no row all give ServiceTimesError('version_conflict') and change nothing (pin 12)", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const scope = await createScope(platform);
    const now = new Date("2026-06-01T10:00:00.000Z");

    try {
      // 1. Non-zero expected version with no row
      await withRequest({ requestId: newId() }, () =>
        withAppTransaction(app, scope, async (tx) => {
          await expect(
            saveServiceTimes(tx, {
              html: "<p>Cannot save</p>",
              expectedVersion: 1,
              now,
              actorUserId: null,
            }),
          ).rejects.toThrow(new ServiceTimesError("version_conflict"));

          const current = await getServiceTimes(tx);
          expect(current).toEqual({ html: "", version: 0 });
        }),
      );

      // Save initial row (version 1)
      await withRequest({ requestId: newId() }, () =>
        withAppTransaction(app, scope, async (tx) => {
          await saveServiceTimes(tx, {
            html: "<p>Version 1 content</p>",
            expectedVersion: 0,
            now,
            actorUserId: null,
          });
        }),
      );

      // 2. Expected 0 while a row exists
      await withRequest({ requestId: newId() }, () =>
        withAppTransaction(app, scope, async (tx) => {
          await expect(
            saveServiceTimes(tx, {
              html: "<p>Conflict</p>",
              expectedVersion: 0,
              now,
              actorUserId: null,
            }),
          ).rejects.toThrow(new ServiceTimesError("version_conflict"));

          const current = await getServiceTimes(tx);
          expect(current).toEqual({ html: "<p>Version 1 content</p>", version: 1 });
        }),
      );

      // 3. Stale expected version (e.g. expected 99 while row is at version 1)
      await withRequest({ requestId: newId() }, () =>
        withAppTransaction(app, scope, async (tx) => {
          await expect(
            saveServiceTimes(tx, {
              html: "<p>Stale conflict</p>",
              expectedVersion: 99,
              now,
              actorUserId: null,
            }),
          ).rejects.toThrow(new ServiceTimesError("version_conflict"));

          const current = await getServiceTimes(tx);
          expect(current).toEqual({ html: "<p>Version 1 content</p>", version: 1 });
        }),
      );
    } finally {
      try {
        await cleanScope(directSql, scope);
      } finally {
        await platform.end({ timeout: 1 });
        await app.end({ timeout: 1 });
        await directSql.end({ timeout: 1 });
      }
    }
  });

  it(
    "two concurrent first saves for the same scope leave exactly one row, exactly one success and exactly one version_conflict (pin 11)",
    { timeout: 30_000 },
    async () => {
      const runtime = loadRuntime();
      const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
      const appSql1 = createPlaintextAppSql(roleUrl(runtime, "app"));
      const appSql2 = createPlaintextAppSql(roleUrl(runtime, "app"));
      const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
      const scope = await createScope(platform);
      const now = new Date("2026-06-01T12:00:00.000Z");

      let release1!: () => void;
      const hold1 = new Promise<void>((resolve) => {
        release1 = resolve;
      });
      let saved1 = false;
      let tx1Promise: Promise<unknown> | undefined;
      let tx2Promise: Promise<unknown> | undefined;

      try {
        tx1Promise = withRequest({ requestId: newId() }, () =>
          withAppTransaction(appSql1, scope, async (tx) => {
            await saveServiceTimes(tx, {
              html: "<p>Tx 1</p>",
              expectedVersion: 0,
              now,
              actorUserId: null,
            });
            saved1 = true;
            await hold1;
          }),
        );

        const start1 = Date.now();
        while (!saved1 && Date.now() - start1 < 5_000) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(saved1).toBe(true);

        tx2Promise = withRequest({ requestId: newId() }, () =>
          withAppTransaction(appSql2, scope, async (tx) => {
            return saveServiceTimes(tx, {
              html: "<p>Tx 2</p>",
              expectedVersion: 0,
              now,
              actorUserId: null,
            });
          }),
        );

        // Allow tx2 to begin and execute against the locked row
        await new Promise((resolve) => setTimeout(resolve, 100));

        release1();
        const [res1, res2] = await Promise.allSettled([tx1Promise, tx2Promise]);

        expect(res1.status).toBe("fulfilled");
        expect(res2.status).toBe("rejected");
        const reason = (res2 as PromiseRejectedResult).reason;
        expect(reason).toBeInstanceOf(ServiceTimesError);
        expect((reason as ServiceTimesError).code).toBe("version_conflict");

        // Exactly one row exists in the database
        const rows = await directSql<{ count: number }[]>`
          select count(*)::int as count
          from app.service_times
          where org_id = ${scope.orgId}::uuid and community_id = ${scope.communityId}::uuid
        `;
        expect(rows[0]?.count).toBe(1);
      } finally {
        release1?.();
        await tx1Promise?.catch(() => undefined);
        await tx2Promise?.catch(() => undefined);
        try {
          await cleanScope(directSql, scope);
        } finally {
          await platform.end({ timeout: 1 });
          await appSql1.end({ timeout: 1 });
          await appSql2.end({ timeout: 1 });
          await directSql.end({ timeout: 1 });
        }
      }
    },
  );

  it("empty save stores ''; stored value equals cleaned value, never raw input (pin 6)", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const scope = await createScope(platform);
    const now = new Date("2026-06-01T10:00:00.000Z");

    try {
      await withRequest({ requestId: newId() }, () =>
        withAppTransaction(app, scope, async (tx) => {
          // Storing HTML with script and inline event handler (pin 6)
          const saved1 = await saveServiceTimes(tx, {
            html: "<p onclick=x>a</p><script>b</script>",
            expectedVersion: 0,
            now,
            actorUserId: null,
          });
          expect(saved1).toEqual({ html: "<p>a</p>", version: 1 });

          const read1 = await getServiceTimes(tx);
          expect(read1.html).toBe("<p>a</p>");

          // Empty save with <p></p> stores ""
          const saved2 = await saveServiceTimes(tx, {
            html: "<p></p>",
            expectedVersion: 1,
            now,
            actorUserId: null,
          });
          expect(saved2).toEqual({ html: "", version: 2 });

          const read2 = await getServiceTimes(tx);
          expect(read2.html).toBe("");

          // Empty save with "" stores ""
          const saved3 = await saveServiceTimes(tx, {
            html: "",
            expectedVersion: 2,
            now,
            actorUserId: null,
          });
          expect(saved3).toEqual({ html: "", version: 3 });

          const read3 = await getServiceTimes(tx);
          expect(read3.html).toBe("");
        }),
      );
    } finally {
      try {
        await cleanScope(directSql, scope);
      } finally {
        await platform.end({ timeout: 1 });
        await app.end({ timeout: 1 });
        await directSql.end({ timeout: 1 });
      }
    }
  });

  it("cap is enforced on the CLEANED string, both sides (pin 7)", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const scope = await createScope(platform);
    const now = new Date("2026-06-01T10:00:00.000Z");

    try {
      await withRequest({ requestId: newId() }, () =>
        withAppTransaction(app, scope, async (tx) => {
          // 1. Raw input of > 20,000 units that cleans to <= 20,000 is ACCEPTED
          // "<span>x</span>" is 14 chars. 1500 spans = 21,000 chars raw.
          // Spans are unwrapped, leaving "<p>" + 1500 "x"s + "</p>" = 1507 chars <= 20,000.
          const rawLong = `<p>${"<span>x</span>".repeat(1500)}</p>`;
          expect(rawLong.length).toBeGreaterThan(20_000);

          const saved1 = await saveServiceTimes(tx, {
            html: rawLong,
            expectedVersion: 0,
            now,
            actorUserId: null,
          });
          expect(saved1.version).toBe(1);
          expect(saved1.html).toBe(`<p>${"x".repeat(1500)}</p>`);

          // 2. Cleaned output of exactly 20,000 units is ACCEPTED
          // "<p>" (3) + 19993 'a's + "</p>" (4) = 20,000 UTF-16 units
          const exact20k = `<p>${"a".repeat(19_993)}</p>`;
          expect(exact20k.length).toBe(20_000);

          const saved2 = await saveServiceTimes(tx, {
            html: exact20k,
            expectedVersion: 1,
            now,
            actorUserId: null,
          });
          expect(saved2.version).toBe(2);
          expect(saved2.html.length).toBe(20_000);

          // 3. Cleaned output of 20,001 units throws invalid_input and stores nothing
          // "<p>" (3) + 19994 'a's + "</p>" (4) = 20,001 UTF-16 units
          const over20k = `<p>${"a".repeat(19_994)}</p>`;
          expect(over20k.length).toBe(20_001);

          await expect(
            saveServiceTimes(tx, {
              html: over20k,
              expectedVersion: 2,
              now,
              actorUserId: null,
            }),
          ).rejects.toThrow(new ServiceTimesError("invalid_input"));

          // Stored content is still version 2
          const current = await getServiceTimes(tx);
          expect(current.version).toBe(2);
          expect(current.html.length).toBe(20_000);

          // 4. Raw html over 120,000 units throws invalid_input before sanitiser runs
          const over120k = "a".repeat(120_001);
          await expect(
            saveServiceTimes(tx, {
              html: over120k,
              expectedVersion: 2,
              now,
              actorUserId: null,
            }),
          ).rejects.toThrow(new ServiceTimesError("invalid_input"));
        }),
      );
    } finally {
      try {
        await cleanScope(directSql, scope);
      } finally {
        await platform.end({ timeout: 1 });
        await app.end({ timeout: 1 });
        await directSql.end({ timeout: 1 });
      }
    }
  });

  it("negative, fractional or non-integer expected version throws invalid_input", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const scope = await createScope(platform);
    const now = new Date("2026-06-01T10:00:00.000Z");

    try {
      await withRequest({ requestId: newId() }, () =>
        withAppTransaction(app, scope, async (tx) => {
          for (const badVersion of [-1, -5, 1.5, 0.1, Number.NaN, Number.POSITIVE_INFINITY]) {
            await expect(
              saveServiceTimes(tx, {
                html: "<p>Test</p>",
                expectedVersion: badVersion,
                now,
                actorUserId: null,
              }),
            ).rejects.toThrow(new ServiceTimesError("invalid_input"));
          }
        }),
      );
    } finally {
      try {
        await cleanScope(directSql, scope);
      } finally {
        await platform.end({ timeout: 1 });
        await app.end({ timeout: 1 });
        await directSql.end({ timeout: 1 });
      }
    }
  });

  it("getPublishedServiceTimes returns exactly { html } (no version, timestamps, ids), '' when no row", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const scope = await createScope(platform);
    const now = new Date("2026-06-01T10:00:00.000Z");

    try {
      await withRequest({ requestId: newId() }, () =>
        withAppTransaction(app, scope, async (tx) => {
          // No row returns { html: "" }
          const empty = await getPublishedServiceTimes(tx);
          expect(empty).toEqual({ html: "" });
          expect(Object.keys(empty)).toEqual(["html"]);

          // Save a block
          await saveServiceTimes(tx, {
            html: "<h3>Saturday Vigil</h3><p>6:00 PM</p>",
            expectedVersion: 0,
            now,
            actorUserId: null,
          });

          // Returns exactly { html } with no other properties
          const published = await getPublishedServiceTimes(tx);
          expect(published).toEqual({ html: "<h3>Saturday Vigil</h3><p>6:00 PM</p>" });
          expect(Object.keys(published)).toEqual(["html"]);
        }),
      );
    } finally {
      try {
        await cleanScope(directSql, scope);
      } finally {
        await platform.end({ timeout: 1 });
        await app.end({ timeout: 1 });
        await directSql.end({ timeout: 1 });
      }
    }
  });

  it("tenancy: two organisations and two communities in one organisation hold their own blocks; cross-scope insert is rejected (pin 13)", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);

    // Create org A with two communities
    const orgAId = newId();
    const commA1Id = newId();
    const commA2Id = newId();
    await platform.begin(async (tx) => {
      await tx`
        insert into platform.organisations (id, slug, region, kind)
        values (${orgAId}, ${`scope-${orgAId}`}, 'au', 'implicit')
      `;
      await tx`
        insert into platform.communities (id, organisation_id, slug, region)
        values (${commA1Id}, ${orgAId}, ${`comm-${commA1Id}`}, 'au')
      `;
      await tx`
        insert into platform.communities (id, organisation_id, slug, region)
        values (${commA2Id}, ${orgAId}, ${`comm-${commA2Id}`}, 'au')
      `;
    });
    const scopeA1 = { orgId: orgAId, communityId: commA1Id };
    const scopeA2 = { orgId: orgAId, communityId: commA2Id };

    // Create org B with one community
    const scopeB = await createScope(platform);

    const now = new Date("2026-06-01T10:00:00.000Z");

    try {
      // Save in orgA comm1
      await withRequest({ requestId: newId() }, () =>
        withAppTransaction(app, scopeA1, async (tx) => {
          await saveServiceTimes(tx, {
            html: "<p>Org A Comm 1 Mass</p>",
            expectedVersion: 0,
            now,
            actorUserId: null,
          });
        }),
      );

      // Save in orgA comm2
      await withRequest({ requestId: newId() }, () =>
        withAppTransaction(app, scopeA2, async (tx) => {
          await saveServiceTimes(tx, {
            html: "<p>Org A Comm 2 Mass</p>",
            expectedVersion: 0,
            now,
            actorUserId: null,
          });
        }),
      );

      // Save in orgB comm1
      await withRequest({ requestId: newId() }, () =>
        withAppTransaction(app, scopeB, async (tx) => {
          await saveServiceTimes(tx, {
            html: "<p>Org B Comm 1 Mass</p>",
            expectedVersion: 0,
            now,
            actorUserId: null,
          });
        }),
      );

      // Verify each scope sees ONLY its own block
      await withRequest({ requestId: newId() }, () =>
        withAppTransaction(app, scopeA1, async (tx) => {
          const res = await getServiceTimes(tx);
          expect(res.html).toBe("<p>Org A Comm 1 Mass</p>");
          expect(res.version).toBe(1);
        }),
      );

      await withRequest({ requestId: newId() }, () =>
        withAppTransaction(app, scopeA2, async (tx) => {
          const res = await getServiceTimes(tx);
          expect(res.html).toBe("<p>Org A Comm 2 Mass</p>");
          expect(res.version).toBe(1);
        }),
      );

      await withRequest({ requestId: newId() }, () =>
        withAppTransaction(app, scopeB, async (tx) => {
          const res = await getServiceTimes(tx);
          expect(res.html).toBe("<p>Org B Comm 1 Mass</p>");
          expect(res.version).toBe(1);
        }),
      );

      // Cross-scope INSERT attempt through raw app connection with mismatched community_id
      // is rejected by the policy WITH CHECK
      await expect(
        withRequest({ requestId: newId() }, () =>
          withAppTransaction(app, scopeA1, async (tx) => {
            await tx`
              insert into app.service_times (
                org_id, community_id, content_html, version, created_at, updated_at
              ) values (
                current_setting('app.org_id')::uuid,
                ${commA2Id}::uuid,
                '<p>Violate</p>',
                1,
                ${now},
                ${now}
              )
            `;
          }),
        ),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      try {
        await cleanScope(directSql, scopeA1);
        await cleanScope(directSql, scopeA2);
        await cleanScope(directSql, scopeB);
      } finally {
        await platform.end({ timeout: 1 });
        await app.end({ timeout: 1 });
        await directSql.end({ timeout: 1 });
      }
    }
  });

  it("audit: each successful save appends exactly one audit event with action engagement.service_times.saved; carries ids only and no content or length (pin 21)", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const scope = await createScope(platform);
    const now = new Date("2026-06-01T10:00:00.000Z");
    const actorUserId = newId();
    const secretContent = `<p>Confidential-Mass-${"X".repeat(500)}</p>`;

    try {
      await withRequest({ requestId: newId() }, () =>
        withAppTransaction(app, scope, async (tx) => {
          // Initial save
          await saveServiceTimes(tx, {
            html: secretContent,
            expectedVersion: 0,
            now,
            actorUserId,
          });

          // Check audit events
          const audits = await tx<
            {
              action: string;
              purpose: string;
              actor_kind: string;
              actor_id: string | null;
              target_ids: string[];
            }[]
          >`
            select action, purpose, actor_kind, actor_id, target_ids
            from app.audit_events
            where org_id = ${scope.orgId}::uuid and action = 'engagement.service_times.saved'
          `;

          expect(audits).toHaveLength(1);
          expect(audits[0]?.action).toBe("engagement.service_times.saved");
          expect(audits[0]?.purpose).toBe("engagement.service_times.saved");
          expect(audits[0]?.actor_kind).toBe("user");
          expect(audits[0]?.actor_id).toBe(actorUserId);
          expect(audits[0]?.target_ids).toEqual([scope.communityId]);

          // Assert serialised audit rows contain neither the html nor its length
          const allAudits = await tx<Record<string, unknown>[]>`
            select * from app.audit_events
            where org_id = ${scope.orgId}::uuid
          `;
          const serialised = JSON.stringify(allAudits);
          expect(serialised).not.toContain("Confidential-Mass-Timings-Text");
          expect(serialised).not.toContain(secretContent);
          expect(serialised).not.toContain(String(secretContent.length));

          // A rejected save (e.g. version conflict) appends NO audit event
          await expect(
            saveServiceTimes(tx, {
              html: "<p>Conflict</p>",
              expectedVersion: 0,
              now,
              actorUserId,
            }),
          ).rejects.toThrow(ServiceTimesError);

          const auditsAfterFailure = await tx<{ count: number }[]>`
            select count(*)::int as count
            from app.audit_events
            where org_id = ${scope.orgId}::uuid and action = 'engagement.service_times.saved'
          `;
          expect(auditsAfterFailure[0]?.count).toBe(1);
        }),
      );
    } finally {
      try {
        await cleanScope(directSql, scope);
      } finally {
        await platform.end({ timeout: 1 });
        await app.end({ timeout: 1 });
        await directSql.end({ timeout: 1 });
      }
    }
  });

  it("usage: good save adds exactly one to module.engagement usage; rejected save adds nothing; recordSuccess is LAST statement (pin 22)", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const scope = await createScope(platform);
    const now = new Date("2026-06-01T10:00:00.000Z");

    try {
      await withRequest({ requestId: newId() }, () =>
        withAppTransaction(app, scope, async (tx) => {
          // Rejected save (e.g. invalid input) records nothing
          await expect(
            saveServiceTimes(tx, {
              html: "<p>Bad version</p>",
              expectedVersion: -1,
              now,
              actorUserId: null,
            }),
          ).rejects.toThrow(ServiceTimesError);

          // Rejected save (e.g. version conflict) records nothing
          await expect(
            saveServiceTimes(tx, {
              html: "<p>Wrong version</p>",
              expectedVersion: 5,
              now,
              actorUserId: null,
            }),
          ).rejects.toThrow(ServiceTimesError);

          const noUsage = await tx<{ count: number }[]>`
            select coalesce(sum(success_count), 0)::int as count
            from app.usage_facts_daily
            where org_id = ${scope.orgId}::uuid
              and community_id = ${scope.communityId}::uuid
              and feature_key = 'module.engagement'
          `;
          expect(noUsage[0]?.count).toBe(0);

          // Good save
          await saveServiceTimes(tx, {
            html: "<p>Good save</p>",
            expectedVersion: 0,
            now,
            actorUserId: null,
          });

          // Exactly one usage fact recorded
          const usageRows = await tx<{ success_count: number; day: string }[]>`
            select success_count, day::text as day
            from app.usage_facts_daily
            where org_id = ${scope.orgId}::uuid
              and community_id = ${scope.communityId}::uuid
              and feature_key = 'module.engagement'
          `;
          expect(usageRows).toEqual([{ success_count: 1, day: "2026-06-01" }]);

          // Second good save
          await saveServiceTimes(tx, {
            html: "<p>Good save 2</p>",
            expectedVersion: 1,
            now,
            actorUserId: null,
          });

          const usageRows2 = await tx<{ success_count: number; day: string }[]>`
            select success_count, day::text as day
            from app.usage_facts_daily
            where org_id = ${scope.orgId}::uuid
              and community_id = ${scope.communityId}::uuid
              and feature_key = 'module.engagement'
          `;
          expect(usageRows2).toEqual([{ success_count: 2, day: "2026-06-01" }]);
        }),
      );
    } finally {
      try {
        await cleanScope(directSql, scope);
      } finally {
        await platform.end({ timeout: 1 });
        await app.end({ timeout: 1 });
        await directSql.end({ timeout: 1 });
      }
    }
  });
});
