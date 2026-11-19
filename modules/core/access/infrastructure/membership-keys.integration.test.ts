import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

import { createLocalKmsPort } from "@community-hub/crypto/testing";
import {
  applyProductMigrations,
  newId,
  withAppTransaction,
  type AppTransaction,
} from "@community-hub/db";
import {
  createPlaintextAppSql,
  createPlaintextDirectSql,
  createPlaintextPlatformSql,
} from "@community-hub/db/plaintext";
import { withRequest } from "@community-hub/kernel";
import { createHousehold, createPerson } from "@community-hub/people";

import { addMember } from "@community-hub/access/testing";

type Runtime = {
  productOnlyUrl: string;
  passwords: { app: string; platform: string };
};

const RUNTIME = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/db/test/.runtime.json",
);

const KEY_ARN = `arn:aws:kms:ap-southeast-2:123456789012:key/mrk-${"ab".repeat(16)}`;
const REQUEST_ID = "55555555-5555-4555-8555-555555555555";
const NOW = new Date("2026-10-11T00:00:00+11:00");

function loadRuntime(): Runtime {
  return JSON.parse(readFileSync(RUNTIME, "utf8")) as Runtime;
}

function roleUrl(runtime: Runtime, role: "app" | "platform"): string {
  const password = encodeURIComponent(runtime.passwords[role]);
  return `postgres://${role}:${password}@127.0.0.1:5432/hub_product_only`;
}

function findPostgresError(error: unknown): { code?: string; constraint_name?: string } | null {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    if ("code" in current && typeof (current as { code?: unknown }).code === "string") {
      return current as { code?: string; constraint_name?: string };
    }
    current = "cause" in current ? (current as { cause?: unknown }).cause : undefined;
  }
  return null;
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

async function createTestPerson(
  tx: AppTransaction,
  kms: ReturnType<typeof createLocalKmsPort>,
  name: string,
): Promise<{ personId: string }> {
  const household = await createHousehold(tx, kms, KEY_ARN, {
    now: NOW,
    label: null,
    actorUserId: null,
  });
  const person = await createPerson(tx, kms, KEY_ARN, {
    now: NOW,
    declaredAdult: true,
    householdId: household.householdId,
    dateOfBirth: "1990-01-01",
    givenName: name,
    familyName: "Example",
    email: null,
    phone: null,
    actorUserId: null,
  });
  return { personId: person.personId };
}

async function createTenant(
  platform: ReturnType<typeof createPlaintextPlatformSql>,
  prefix: string,
): Promise<{ organisationId: string; communityId: string }> {
  const organisationId = newId();
  const communityId = newId();
  const slug = `${prefix}-${newId().replaceAll("-", "").slice(0, 12)}`;
  await platform.begin(async (tx) => {
    await tx`
      insert into platform.organisations (id, slug, region, kind)
      values (${organisationId}, ${slug}, 'au', 'implicit')
    `;
    await tx`
      insert into platform.communities (id, organisation_id, slug, region)
      values (${communityId}, ${organisationId}, ${slug}, 'au')
    `;
  });
  return { organisationId, communityId };
}

describe("membership foreign keys", () => {
  it("refuses an organisation role grant for a user with no membership", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    try {
      const scope = await createTenant(platform, "org-grant");
      const outsider = newId();

      let error: unknown = null;
      try {
        await withRequest({ requestId: REQUEST_ID }, () =>
          withAppTransaction(
            app,
            { orgId: scope.organisationId, communityId: scope.communityId },
            async (tx) => {
              await tx`
                insert into app.organisation_role_grants (id, org_id, user_id, role_key)
                values (${newId()}::uuid, current_setting('app.org_id')::uuid, ${outsider}::uuid, 'org_admin')
              `;
            },
          ),
        );
      } catch (err) {
        error = err;
      }

      const pgError = findPostgresError(error);
      expect(pgError?.code).toBe("23503");
      expect(pgError?.constraint_name).toBe("organisation_role_grants_member_fk");

      // Positive case in a second transaction after addMember
      const member = newId();
      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(
          app,
          { orgId: scope.organisationId, communityId: scope.communityId },
          async (tx) => {
            await addMember(tx, member);
            await tx`
              insert into app.organisation_role_grants (id, org_id, user_id, role_key)
              values (${newId()}::uuid, current_setting('app.org_id')::uuid, ${member}::uuid, 'org_admin')
            `;
            const rows = await tx<{ id: string }[]>`
              select id from app.organisation_role_grants where user_id = ${member}::uuid
            `;
            expect(rows).toHaveLength(1);
          },
        ),
      );
    } finally {
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
    }
  });

  it("refuses a community role grant for a user with no membership", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    try {
      const scope = await createTenant(platform, "comm-grant");
      const outsider = newId();

      let error: unknown = null;
      try {
        await withRequest({ requestId: REQUEST_ID }, () =>
          withAppTransaction(
            app,
            { orgId: scope.organisationId, communityId: scope.communityId },
            async (tx) => {
              await tx`
                insert into app.community_role_grants (
                  id, org_id, community_id, user_id, role_key, custom_role_id
                ) values (
                  ${newId()}::uuid,
                  current_setting('app.org_id')::uuid,
                  current_setting('app.community_id')::uuid,
                  ${outsider}::uuid,
                  'member',
                  null
                )
              `;
            },
          ),
        );
      } catch (err) {
        error = err;
      }

      const pgError = findPostgresError(error);
      expect(pgError?.code).toBe("23503");
      expect(pgError?.constraint_name).toBe("community_role_grants_member_fk");

      // Positive case in a second transaction after addMember
      const member = newId();
      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(
          app,
          { orgId: scope.organisationId, communityId: scope.communityId },
          async (tx) => {
            await addMember(tx, member);
            await tx`
              insert into app.community_role_grants (
                id, org_id, community_id, user_id, role_key, custom_role_id
              ) values (
                ${newId()}::uuid,
                current_setting('app.org_id')::uuid,
                current_setting('app.community_id')::uuid,
                ${member}::uuid,
                'member',
                null
              )
            `;
            const rows = await tx<{ id: string }[]>`
              select id from app.community_role_grants where user_id = ${member}::uuid
            `;
            expect(rows).toHaveLength(1);
          },
        ),
      );
    } finally {
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
    }
  });

  it("refuses a user link for a user with no membership", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const kms = createLocalKmsPort();
    try {
      const scope = await createTenant(platform, "user-link");
      let person1Id!: string;
      let person2Id!: string;

      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(
          app,
          { orgId: scope.organisationId, communityId: scope.communityId },
          async (tx) => {
            const p1 = await createTestPerson(tx, kms, "LinkPerson1");
            const p2 = await createTestPerson(tx, kms, "LinkPerson2");
            person1Id = p1.personId;
            person2Id = p2.personId;
          },
        ),
      );

      const outsider = newId();
      let error: unknown = null;
      try {
        await withRequest({ requestId: REQUEST_ID }, () =>
          withAppTransaction(
            app,
            { orgId: scope.organisationId, communityId: scope.communityId },
            async (tx) => {
              await tx`
                insert into app.user_links (id, org_id, community_id, user_id, person_id)
                values (
                  ${newId()}::uuid,
                  current_setting('app.org_id')::uuid,
                  current_setting('app.community_id')::uuid,
                  ${outsider}::uuid,
                  ${person1Id}::uuid
                )
              `;
            },
          ),
        );
      } catch (err) {
        error = err;
      }

      const pgError = findPostgresError(error);
      expect(pgError?.code).toBe("23503");
      expect(pgError?.constraint_name).toBe("user_links_member_fk");

      // Positive case in a second transaction after addMember, using a second person
      const member = newId();
      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(
          app,
          { orgId: scope.organisationId, communityId: scope.communityId },
          async (tx) => {
            await addMember(tx, member);
            await tx`
              insert into app.user_links (id, org_id, community_id, user_id, person_id)
              values (
                ${newId()}::uuid,
                current_setting('app.org_id')::uuid,
                current_setting('app.community_id')::uuid,
                ${member}::uuid,
                ${person2Id}::uuid
              )
            `;
            const rows = await tx<{ id: string }[]>`
              select id from app.user_links where user_id = ${member}::uuid
            `;
            expect(rows).toHaveLength(1);
          },
        ),
      );
    } finally {
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
    }
  });

  it("refuses a grant or link in another organisation for a member of one organisation only", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const kms = createLocalKmsPort();
    try {
      const scopeA = await createTenant(platform, "two-org-a");
      const scopeB = await createTenant(platform, "two-org-b");

      let personAId!: string;
      let personBId!: string;

      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(
          app,
          { orgId: scopeA.organisationId, communityId: scopeA.communityId },
          async (tx) => {
            const pA = await createTestPerson(tx, kms, "TwoOrgPersonA");
            personAId = pA.personId;
          },
        ),
      );

      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(
          app,
          { orgId: scopeB.organisationId, communityId: scopeB.communityId },
          async (tx) => {
            const pB = await createTestPerson(tx, kms, "TwoOrgPersonB");
            personBId = pB.personId;
          },
        ),
      );

      const user = newId();
      // User is a member of organisation A only
      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(
          app,
          { orgId: scopeA.organisationId, communityId: scopeA.communityId },
          async (tx) => {
            await addMember(tx, user);
          },
        ),
      );

      // 1. Organisation role grant: refused in B, succeeds in A
      let errOrgB: unknown = null;
      try {
        await withRequest({ requestId: REQUEST_ID }, () =>
          withAppTransaction(
            app,
            { orgId: scopeB.organisationId, communityId: scopeB.communityId },
            async (tx) => {
              await tx`
                insert into app.organisation_role_grants (id, org_id, user_id, role_key)
                values (${newId()}::uuid, current_setting('app.org_id')::uuid, ${user}::uuid, 'org_admin')
              `;
            },
          ),
        );
      } catch (err) {
        errOrgB = err;
      }
      const pgErrOrg = findPostgresError(errOrgB);
      expect(pgErrOrg?.code).toBe("23503");
      expect(pgErrOrg?.constraint_name).toBe("organisation_role_grants_member_fk");

      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(
          app,
          { orgId: scopeA.organisationId, communityId: scopeA.communityId },
          async (tx) => {
            await tx`
              insert into app.organisation_role_grants (id, org_id, user_id, role_key)
              values (${newId()}::uuid, current_setting('app.org_id')::uuid, ${user}::uuid, 'org_admin')
            `;
            const rows = await tx<{ id: string }[]>`
              select id from app.organisation_role_grants where user_id = ${user}::uuid
            `;
            expect(rows).toHaveLength(1);
          },
        ),
      );

      // 2. Community role grant: refused in B, succeeds in A
      let errCommB: unknown = null;
      try {
        await withRequest({ requestId: REQUEST_ID }, () =>
          withAppTransaction(
            app,
            { orgId: scopeB.organisationId, communityId: scopeB.communityId },
            async (tx) => {
              await tx`
                insert into app.community_role_grants (
                  id, org_id, community_id, user_id, role_key, custom_role_id
                ) values (
                  ${newId()}::uuid,
                  current_setting('app.org_id')::uuid,
                  current_setting('app.community_id')::uuid,
                  ${user}::uuid,
                  'member',
                  null
                )
              `;
            },
          ),
        );
      } catch (err) {
        errCommB = err;
      }
      const pgErrComm = findPostgresError(errCommB);
      expect(pgErrComm?.code).toBe("23503");
      expect(pgErrComm?.constraint_name).toBe("community_role_grants_member_fk");

      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(
          app,
          { orgId: scopeA.organisationId, communityId: scopeA.communityId },
          async (tx) => {
            await tx`
              insert into app.community_role_grants (
                id, org_id, community_id, user_id, role_key, custom_role_id
              ) values (
                ${newId()}::uuid,
                current_setting('app.org_id')::uuid,
                current_setting('app.community_id')::uuid,
                ${user}::uuid,
                'member',
                null
              )
            `;
            const rows = await tx<{ id: string }[]>`
              select id from app.community_role_grants where user_id = ${user}::uuid
            `;
            expect(rows).toHaveLength(1);
          },
        ),
      );

      // 3. User link: refused in B, succeeds in A
      let errLinkB: unknown = null;
      try {
        await withRequest({ requestId: REQUEST_ID }, () =>
          withAppTransaction(
            app,
            { orgId: scopeB.organisationId, communityId: scopeB.communityId },
            async (tx) => {
              await tx`
                insert into app.user_links (id, org_id, community_id, user_id, person_id)
                values (
                  ${newId()}::uuid,
                  current_setting('app.org_id')::uuid,
                  current_setting('app.community_id')::uuid,
                  ${user}::uuid,
                  ${personBId}::uuid
                )
              `;
            },
          ),
        );
      } catch (err) {
        errLinkB = err;
      }
      const pgErrLink = findPostgresError(errLinkB);
      expect(pgErrLink?.code).toBe("23503");
      expect(pgErrLink?.constraint_name).toBe("user_links_member_fk");

      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(
          app,
          { orgId: scopeA.organisationId, communityId: scopeA.communityId },
          async (tx) => {
            await tx`
              insert into app.user_links (id, org_id, community_id, user_id, person_id)
              values (
                ${newId()}::uuid,
                current_setting('app.org_id')::uuid,
                current_setting('app.community_id')::uuid,
                ${user}::uuid,
                ${personAId}::uuid
              )
            `;
            const rows = await tx<{ id: string }[]>`
              select id from app.user_links where user_id = ${user}::uuid
            `;
            expect(rows).toHaveLength(1);
          },
        ),
      );
    } finally {
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
    }
  });

  it("refuses to delete a membership that a grant or link still references", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const direct = createPlaintextDirectSql(runtime.productOnlyUrl);
    const kms = createLocalKmsPort();
    try {
      const scope = await createTenant(platform, "restrict");
      let personId!: string;
      const user = newId();
      const orgGrantId = newId();
      const commGrantId = newId();
      const linkId = newId();

      // Populate user with membership and all three referenced rows
      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(
          app,
          { orgId: scope.organisationId, communityId: scope.communityId },
          async (tx) => {
            const p = await createTestPerson(tx, kms, "RestrictPerson");
            personId = p.personId;
            await addMember(tx, user);
            await tx`
              insert into app.organisation_role_grants (id, org_id, user_id, role_key)
              values (${orgGrantId}::uuid, current_setting('app.org_id')::uuid, ${user}::uuid, 'org_admin')
            `;
            await tx`
              insert into app.community_role_grants (
                id, org_id, community_id, user_id, role_key, custom_role_id
              ) values (
                ${commGrantId}::uuid,
                current_setting('app.org_id')::uuid,
                current_setting('app.community_id')::uuid,
                ${user}::uuid,
                'member',
                null
              )
            `;
            await tx`
              insert into app.user_links (id, org_id, community_id, user_id, person_id)
              values (
                ${linkId}::uuid,
                current_setting('app.org_id')::uuid,
                current_setting('app.community_id')::uuid,
                ${user}::uuid,
                ${personId}::uuid
              )
            `;
          },
        ),
      );

      // Case 2a: organisation role grant restricts membership deletion
      let error2a: unknown = null;
      try {
        await direct.begin(async (tx) => {
          await tx.unsafe("set local role migrator");
          await tx`select set_config('app.org_id', ${scope.organisationId}, true)`;
          await tx`select set_config('app.community_id', ${scope.communityId}, true)`;
          await tx`delete from app.community_role_grants where id = ${commGrantId}::uuid`;
          await tx`delete from app.user_links where id = ${linkId}::uuid`;
          try {
            await tx`delete from app.organisation_members where user_id = ${user}::uuid`;
          } catch (err) {
            error2a = err;
          }
          throw new Error("force_rollback");
        });
      } catch (err) {
        if ((err as Error)?.message !== "force_rollback") {
          throw err;
        }
      }
      const pgError2a = findPostgresError(error2a);
      expect(pgError2a?.code).toBe("23503");
      expect(pgError2a?.constraint_name).toBe("organisation_role_grants_member_fk");

      // Case 2b: community role grant restricts membership deletion
      let error2b: unknown = null;
      try {
        await direct.begin(async (tx) => {
          await tx.unsafe("set local role migrator");
          await tx`select set_config('app.org_id', ${scope.organisationId}, true)`;
          await tx`select set_config('app.community_id', ${scope.communityId}, true)`;
          await tx`delete from app.organisation_role_grants where id = ${orgGrantId}::uuid`;
          await tx`delete from app.user_links where id = ${linkId}::uuid`;
          try {
            await tx`delete from app.organisation_members where user_id = ${user}::uuid`;
          } catch (err) {
            error2b = err;
          }
          throw new Error("force_rollback");
        });
      } catch (err) {
        if ((err as Error)?.message !== "force_rollback") {
          throw err;
        }
      }
      const pgError2b = findPostgresError(error2b);
      expect(pgError2b?.code).toBe("23503");
      expect(pgError2b?.constraint_name).toBe("community_role_grants_member_fk");

      // Case 2c: user link restricts membership deletion
      let error2c: unknown = null;
      try {
        await direct.begin(async (tx) => {
          await tx.unsafe("set local role migrator");
          await tx`select set_config('app.org_id', ${scope.organisationId}, true)`;
          await tx`select set_config('app.community_id', ${scope.communityId}, true)`;
          await tx`delete from app.organisation_role_grants where id = ${orgGrantId}::uuid`;
          await tx`delete from app.community_role_grants where id = ${commGrantId}::uuid`;
          try {
            await tx`delete from app.organisation_members where user_id = ${user}::uuid`;
          } catch (err) {
            error2c = err;
          }
          throw new Error("force_rollback");
        });
      } catch (err) {
        if ((err as Error)?.message !== "force_rollback") {
          throw err;
        }
      }
      const pgError2c = findPostgresError(error2c);
      expect(pgError2c?.code).toBe("23503");
      expect(pgError2c?.constraint_name).toBe("user_links_member_fk");
    } finally {
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
      await direct.end({ timeout: 1 });
    }
  });
});
