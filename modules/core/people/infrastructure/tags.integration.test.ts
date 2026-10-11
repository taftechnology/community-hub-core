import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

import { createLocalKmsPort } from "@community-hub/crypto/testing";
import { applyProductMigrations, newId, withAppTransaction } from "@community-hub/db";
import {
  createPlaintextAppSql,
  createPlaintextDirectSql,
  createPlaintextPlatformSql,
} from "@community-hub/db/plaintext";
import { withRequest } from "@community-hub/kernel";

import {
  attachTag,
  createPerson,
  createTag,
  detachTag,
  listPersonActivity,
  listPersonTags,
} from "../public/index.js";

type Runtime = {
  productOnlyUrl: string;
  passwords: { app: string; platform: string };
};

const RUNTIME = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/db/test/.runtime.json",
);

const KEY_ARN = `arn:aws:kms:ap-southeast-2:123456789012:key/mrk-${"ab".repeat(16)}`;
const REQUEST_ID = "44444444-4444-4444-8444-444444444444";
const NOW = new Date("2026-10-11T00:00:00+11:00");
const ACTIVITY_KEYS = ["actorUserId", "id", "kind", "occurredAt"];

function loadRuntime(): Runtime {
  return JSON.parse(readFileSync(RUNTIME, "utf8")) as Runtime;
}

function roleUrl(runtime: Runtime, role: "app" | "platform"): string {
  const password = encodeURIComponent(runtime.passwords[role]);
  return `postgres://${role}:${password}@127.0.0.1:5432/hub_product_only`;
}

beforeAll(async () => {
  const runtime = loadRuntime();
  const migration = createPlaintextDirectSql(runtime.productOnlyUrl);
  try {
    await applyProductMigrations(migration);
  } finally {
    await migration.end({ timeout: 1 });
  }
});

describe("tags and activity", () => {
  it("stores a clear label and lists activity without a name", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const organisationId = newId();
    const communityId = newId();
    const kms = createLocalKmsPort();
    try {
      await platform.begin(async (tx) => {
        await tx`
          insert into platform.organisations (id, slug, region, kind)
          values (${organisationId}, 'tag-parish', 'au', 'implicit')
        `;
        await tx`
          insert into platform.communities (id, organisation_id, slug, region)
          values (${communityId}, ${organisationId}, 'tag-parish', 'au')
        `;
      });

      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, { orgId: organisationId, communityId }, async (tx) => {
          const adult = await createPerson(tx, kms, KEY_ARN, {
            now: NOW,
            declaredAdult: false,
            householdId: null,
            dateOfBirth: "2008-10-11",
            givenName: "Ada",
            familyName: "Example",
            email: null,
            phone: null,
            actorUserId: null,
          });
          const created = await createTag(tx, { label: "Choir" });
          const stored = await tx<{ label: string }[]>`
            select label from app.person_tags where id = ${created.tagId}::uuid
          `;
          expect(stored).toEqual([{ label: "choir" }]);
          await expect(createTag(tx, { label: "Choir" })).rejects.toMatchObject({
            code: "duplicate_tag",
          });
          await expect(createTag(tx, { label: "A_b" })).rejects.toMatchObject({
            code: "invalid_tag",
          });
          const labels = await tx<{ n: number }[]>`
            select count(*)::int as n from app.person_tags
          `;
          expect(labels).toEqual([{ n: 1 }]);

          expect(await listPersonTags(tx, adult.personId)).toEqual([]);
          await attachTag(tx, {
            now: NOW,
            personId: adult.personId,
            tagId: created.tagId,
            actorUserId: null,
          });
          const tagged = await tx<{ n: number }[]>`
            select count(*)::int as n
            from app.person_activity
            where person_id = ${adult.personId}::uuid and kind = 'tagged'
          `;
          expect(tagged).toEqual([{ n: 1 }]);
          await expect(
            attachTag(tx, {
              now: NOW,
              personId: adult.personId,
              tagId: created.tagId,
              actorUserId: null,
            }),
          ).rejects.toMatchObject({ code: "duplicate_tag" });
          const taggedAgain = await tx<{ n: number }[]>`
            select count(*)::int as n
            from app.person_activity
            where person_id = ${adult.personId}::uuid and kind = 'tagged'
          `;
          expect(taggedAgain).toEqual([{ n: 1 }]);

          expect(await listPersonTags(tx, adult.personId)).toEqual([
            { tagId: created.tagId, label: "choir" },
          ]);
          const activity = await listPersonActivity(tx, adult.personId);
          expect(activity?.map((row) => row.kind)).toEqual(["created", "tagged"]);
          for (const row of activity ?? []) {
            expect(Object.keys(row).sort()).toEqual(ACTIVITY_KEYS);
          }

          await detachTag(tx, {
            now: NOW,
            personId: adult.personId,
            tagId: created.tagId,
            actorUserId: null,
          });
          const afterDetach = await listPersonActivity(tx, adult.personId);
          expect(afterDetach?.map((row) => row.kind)).toEqual(["created", "tagged", "untagged"]);
          expect(await listPersonTags(tx, adult.personId)).toEqual([]);

          const missingId = newId();
          expect(await listPersonTags(tx, missingId)).toBeNull();
          expect(await listPersonActivity(tx, missingId)).toBeNull();
        }),
      );
    } finally {
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
    }
  });
});
