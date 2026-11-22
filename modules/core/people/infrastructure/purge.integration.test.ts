import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Sql, TransactionSql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { applyProductMigrations, newId, withAppTransaction } from "@community-hub/db";
import {
  createPlaintextAppSql,
  createPlaintextDirectSql,
  createPlaintextPlatformSql,
} from "@community-hub/db/plaintext";
import { withRequest } from "@community-hub/kernel";

import { purgeDeletedPersons } from "../public/index.js";

type Runtime = {
  productOnlyUrl: string;
  passwords: { app: string; platform: string };
};

const RUNTIME = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/db/test/.runtime.json",
);

const REQUEST_ID = "55555555-5555-4555-8555-555555555555";
const FAKE_ENCRYPTED = Buffer.from("0123456789abcdef0123456789abcdef");

function loadRuntime(): Runtime {
  return JSON.parse(readFileSync(RUNTIME, "utf8")) as Runtime;
}

function roleUrl(runtime: Runtime, role: "app" | "platform"): string {
  const password = encodeURIComponent(runtime.passwords[role]);
  return `postgres://${role}:${password}@127.0.0.1:5432/hub_product_only`;
}

describe("purgeDeletedPersons", () => {
  let runtime: Runtime;
  let platform: ReturnType<typeof createPlaintextPlatformSql>;
  let app: ReturnType<typeof createPlaintextAppSql>;
  let migrator: ReturnType<typeof createPlaintextDirectSql>;

  beforeAll(async () => {
    runtime = loadRuntime();
    migrator = createPlaintextDirectSql(runtime.productOnlyUrl);
    await applyProductMigrations(migrator);
    platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    app = createPlaintextAppSql(roleUrl(runtime, "app"));
  });

  afterAll(async () => {
    await app.end({ timeout: 1 });
    await platform.end({ timeout: 1 });
    await migrator.end({ timeout: 1 });
  });

  async function setupTenant(slugPrefix = "purge") {
    const organisationId = newId();
    const communityId = newId();
    await platform.begin(async (tx) => {
      await tx`
        insert into platform.organisations (id, slug, region, kind)
        values (${organisationId}, ${`${slugPrefix}-${organisationId}`}, 'au', 'implicit')
      `;
      await tx`
        insert into platform.communities (id, organisation_id, slug, region)
        values (${communityId}, ${organisationId}, ${`${slugPrefix}-${communityId}`}, 'au')
      `;
    });
    return { orgId: organisationId, communityId };
  }

  async function insertAdult(
    scope: { orgId: string; communityId: string },
    givenName = "Adult",
    familyName = "Test",
  ): Promise<string> {
    const id = newId();
    await withAppTransaction(migrator, scope, async (tx) => {
      await tx`
        insert into app.persons (id, org_id, community_id, version, is_minor, age_basis, given_name, family_name)
        values (${id}, ${scope.orgId}, ${scope.communityId}, 1, false, 'declared_adult', ${givenName}, ${familyName})
      `;
    });
    return id;
  }

  async function insertMinor(scope: {
    orgId: string;
    communityId: string;
  }): Promise<{ minorId: string; householdId: string }> {
    const minorId = newId();
    const householdId = newId();
    await withAppTransaction(migrator, scope, async (tx) => {
      await tx`
        insert into app.households (id, org_id, community_id)
        values (${householdId}, ${scope.orgId}, ${scope.communityId})
      `;
      await tx`
        insert into app.persons (id, org_id, community_id, household_id, version, is_minor, age_basis, given_name_restricted, family_name_restricted)
        values (${minorId}, ${scope.orgId}, ${scope.communityId}, ${householdId}, 1, true, 'unknown', ${FAKE_ENCRYPTED}, ${FAKE_ENCRYPTED})
      `;
    });
    return { minorId, householdId };
  }

  async function agePerson(
    scope: { orgId: string; communityId: string },
    personId: string,
    hours = 721,
    deletedBy = newId(),
  ): Promise<void> {
    await withAppTransaction(migrator, scope, async (tx) => {
      await tx.unsafe("ALTER TABLE app.persons DISABLE TRIGGER USER");
      await tx`
        update app.persons
        set deleted_at = now() - (${hours} * interval '1 hour'),
            deleted_by = ${deletedBy}
        where id = ${personId}
      `;
      await tx.unsafe("ALTER TABLE app.persons ENABLE TRIGGER USER");
    });
  }

  async function getPerson(
    scope: { orgId: string; communityId: string },
    personId: string,
  ): Promise<{ id: string; deleted_at: Date | null } | undefined> {
    return withAppTransaction(migrator, scope, async (tx) => {
      const [row] = await tx<{ id: string; deleted_at: Date | null }[]>`
        select id::text as id, deleted_at
        from app.persons
        where id = ${personId}
      `;
      return row;
    });
  }

  async function getFkReferencingPersons(sqlClient: Sql | TransactionSql): Promise<string[]> {
    const rows = await sqlClient<{ table_name: string }[]>`
      select distinct c_rel.relname as table_name
      from pg_constraint c
      join pg_class c_rel on c_rel.oid = c.conrelid
      join pg_namespace c_ns on c_ns.oid = c_rel.relnamespace
      join pg_class f_rel on f_rel.oid = c.confrelid
      join pg_namespace f_ns on f_ns.oid = f_rel.relnamespace
      where c.contype = 'f'
        and f_ns.nspname = 'app'
        and f_rel.relname = 'persons'
    `;
    return rows.map((r) => r.table_name);
  }

  async function getHandledTablesFromFunctionDef(
    sqlClient: Sql | TransactionSql,
  ): Promise<Set<string>> {
    const [proc] = await sqlClient<{ def: string }[]>`
      select pg_get_functiondef(p.oid) as def
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'app'
        and p.proname = 'purge_deleted_persons'
    `;
    if (!proc?.def) {
      return new Set();
    }
    const cleanDef = proc.def.replace(/--.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

    const handled = new Set<string>();
    const deleteMatches = cleanDef.matchAll(/delete\s+from\s+app\.([a-z0-9_]+)/gi);
    for (const m of deleteMatches) {
      if (m[1]) {
        handled.add(m[1].toLowerCase());
      }
    }
    const updateMatches = cleanDef.matchAll(/update\s+app\.([a-z0-9_]+)/gi);
    for (const m of updateMatches) {
      if (m[1]) {
        handled.add(m[1].toLowerCase());
      }
    }
    if (/app\.user_links\b/i.test(cleanDef)) {
      handled.add("user_links");
    }
    return handled;
  }

  it("purge leaves a contact hidden 719 hours", async () => {
    const scope = await setupTenant("p15");
    const adult719 = await insertAdult(scope, "Hidden", "SevenNineteen");
    const adult721 = await insertAdult(scope, "Hidden", "SevenTwentyOne");
    const adultVisible = await insertAdult(scope, "Visible", "Contact");

    await agePerson(scope, adult719, 719);
    await agePerson(scope, adult721, 721);

    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, scope, async (tx) => {
        await expect(purgeDeletedPersons(tx, 50)).resolves.toEqual([adult721]);
      }),
    );

    const survivor719 = await getPerson(scope, adult719);
    expect(survivor719).toBeDefined();
    expect(survivor719?.deleted_at).not.toBeNull();

    const survivorVisible = await getPerson(scope, adultVisible);
    expect(survivorVisible).toBeDefined();
    expect(survivorVisible?.deleted_at).toBeNull();

    const purged721 = await getPerson(scope, adult721);
    expect(purged721).toBeUndefined();
  });

  it("purge never deletes a minor even with deleted_at set", async () => {
    const scope = await setupTenant("p16");
    const adult = await insertAdult(scope, "Eligible", "Adult");
    await agePerson(scope, adult, 721);

    const { minorId } = await insertMinor(scope);
    await agePerson(scope, minorId, 721);

    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, scope, async (tx) => {
        await expect(purgeDeletedPersons(tx, 50)).resolves.toEqual([adult]);
      }),
    );

    const minorSurvivor = await getPerson(scope, minorId);
    expect(minorSurvivor).toBeDefined();
    expect(minorSurvivor?.deleted_at).not.toBeNull();

    const adultPurged = await getPerson(scope, adult);
    expect(adultPurged).toBeUndefined();
  });

  it("purge deletes only the scoped community's contacts", async () => {
    const orgId = newId();
    const comm1Id = newId();
    const comm2Id = newId();

    await platform.begin(async (tx) => {
      await tx`
        insert into platform.organisations (id, slug, region, kind)
        values (${orgId}, ${`scoped-${orgId}`}, 'au', 'implicit')
      `;
      await tx`
        insert into platform.communities (id, organisation_id, slug, region)
        values (${comm1Id}, ${orgId}, ${`scoped-1-${comm1Id}`}, 'au'),
               (${comm2Id}, ${orgId}, ${`scoped-2-${comm2Id}`}, 'au')
      `;
    });

    const contact1 = await insertAdult({ orgId, communityId: comm1Id }, "Comm1", "Contact");
    await agePerson({ orgId, communityId: comm1Id }, contact1, 721);

    const contact2 = await insertAdult({ orgId, communityId: comm2Id }, "Comm2", "Contact");
    await agePerson({ orgId, communityId: comm2Id }, contact2, 721);

    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, { orgId, communityId: comm1Id }, async (tx) => {
        await expect(purgeDeletedPersons(tx, 50)).resolves.toEqual([contact1]);
      }),
    );

    const survivor = await getPerson({ orgId, communityId: comm2Id }, contact2);
    expect(survivor).toBeDefined();

    const purged = await getPerson({ orgId, communityId: comm1Id }, contact1);
    expect(purged).toBeUndefined();
  });

  it("purge leaves another organisation's contacts untouched", async () => {
    const scope1 = await setupTenant("org1");
    const scope2 = await setupTenant("org2");

    const contact1 = await insertAdult(scope1, "Org1", "Adult");
    await agePerson(scope1, contact1, 721);

    const contact2 = await insertAdult(scope2, "Org2", "Adult");
    await agePerson(scope2, contact2, 721);

    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, scope1, async (tx) => {
        await expect(purgeDeletedPersons(tx, 50)).resolves.toEqual([contact1]);
      }),
    );

    const survivor = await getPerson(scope2, contact2);
    expect(survivor).toBeDefined();

    const purged = await getPerson(scope1, contact1);
    expect(purged).toBeUndefined();
  });

  it("purge skips a contact linked to a user", async () => {
    const scope = await setupTenant("p18");
    const contactLinked = await insertAdult(scope, "Linked", "User");
    await agePerson(scope, contactLinked, 721);

    const contactEligible = await insertAdult(scope, "Eligible", "NoUser");
    await agePerson(scope, contactEligible, 721);

    const userId = newId();
    await withAppTransaction(migrator, scope, async (tx) => {
      await tx`
        insert into app.organisation_members (org_id, user_id, source, created_at)
        values (${scope.orgId}, ${userId}, 'provision', now())
      `;
      await tx`
        insert into app.user_links (id, org_id, community_id, user_id, person_id)
        values (${newId()}, ${scope.orgId}, ${scope.communityId}, ${userId}, ${contactLinked})
      `;
    });

    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, scope, async (tx) => {
        await expect(purgeDeletedPersons(tx, 50)).resolves.toEqual([contactEligible]);
      }),
    );

    const survivor = await getPerson(scope, contactLinked);
    expect(survivor).toBeDefined();

    const purged = await getPerson(scope, contactEligible);
    expect(purged).toBeUndefined();
  });

  it("purge skips a contact with a live pending invitation", async () => {
    const scope = await setupTenant("live-inv");
    const contactInvited = await insertAdult(scope, "Live", "Invited");
    await agePerson(scope, contactInvited, 721);

    const contactEligible = await insertAdult(scope, "Eligible", "Purge");
    await agePerson(scope, contactEligible, 721);

    await withAppTransaction(migrator, scope, async (tx) => {
      await tx`
        insert into app.invitations (
          id, org_id, community_id, invited_by, token_hash, person_id, status, expires_at, resend_count, last_sent_at, created_at
        ) values (
          ${newId()}, ${scope.orgId}, ${scope.communityId}, ${newId()}, ${FAKE_ENCRYPTED},
          ${contactInvited}, 'pending', now() + interval '7 days', 0, now(), now()
        )
      `;
    });

    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, scope, async (tx) => {
        await expect(purgeDeletedPersons(tx, 50)).resolves.toEqual([contactEligible]);
      }),
    );

    const survivor = await getPerson(scope, contactInvited);
    expect(survivor).toBeDefined();

    const purged = await getPerson(scope, contactEligible);
    expect(purged).toBeUndefined();
  });

  it("purge voids an expired pending invitation and deletes the contact", async () => {
    const scope = await setupTenant("p19");
    const contact = await insertAdult(scope, "Expired", "Invitation");
    await agePerson(scope, contact, 721);

    const invitationId = newId();
    await withAppTransaction(migrator, scope, async (tx) => {
      await tx`
        insert into app.invitations (
          id, org_id, community_id, invited_by, token_hash, person_id, status, expires_at, resend_count, last_sent_at, created_at
        ) values (
          ${invitationId}, ${scope.orgId}, ${scope.communityId}, ${newId()}, ${FAKE_ENCRYPTED},
          ${contact}, 'pending', now() - interval '1 hour', 0, now() - interval '8 days', now() - interval '8 days'
        )
      `;
    });

    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, scope, async (tx) => {
        await expect(purgeDeletedPersons(tx, 50)).resolves.toEqual([contact]);
      }),
    );

    const purged = await getPerson(scope, contact);
    expect(purged).toBeUndefined();

    const [invitation] = await withAppTransaction(migrator, scope, async (tx) => {
      return tx<{ status: string; person_id: string | null; closed_at: Date | null }[]>`
        select status, person_id, closed_at
        from app.invitations
        where id = ${invitationId}
      `;
    });
    expect(invitation).toBeDefined();
    expect(invitation?.status).toBe("void");
    expect(invitation?.person_id).toBeNull();
    expect(invitation?.closed_at).not.toBeNull();
  });

  it("sets person_id null on accepted and revoked invitations and deletes the contact", async () => {
    const scope = await setupTenant("inv-status");
    const cAccepted = await insertAdult(scope, "Accepted", "Inv");
    await agePerson(scope, cAccepted, 721);
    const invAccepted = newId();

    const cRevoked = await insertAdult(scope, "Revoked", "Inv");
    await agePerson(scope, cRevoked, 721);
    const invRevoked = newId();

    const cVoid = await insertAdult(scope, "Void", "Inv");
    await agePerson(scope, cVoid, 721);
    const invVoid = newId();

    await withAppTransaction(migrator, scope, async (tx) => {
      await tx`
        insert into app.invitations (
          id, org_id, community_id, invited_by, token_hash, person_id, status, expires_at, resend_count, last_sent_at, accepted_user_id, created_at
        ) values (
          ${invAccepted}, ${scope.orgId}, ${scope.communityId}, ${newId()}, ${FAKE_ENCRYPTED},
          ${cAccepted}, 'accepted', now() + interval '7 days', 0, now(), ${newId()}, now()
        )
      `;
      await tx`
        insert into app.invitations (
          id, org_id, community_id, invited_by, token_hash, person_id, status, expires_at, resend_count, last_sent_at, closed_at, created_at
        ) values (
          ${invRevoked}, ${scope.orgId}, ${scope.communityId}, ${newId()}, ${FAKE_ENCRYPTED},
          ${cRevoked}, 'revoked', now() + interval '7 days', 0, now(), now(), now()
        )
      `;
      await tx`
        insert into app.invitations (
          id, org_id, community_id, invited_by, token_hash, person_id, status, expires_at, resend_count, last_sent_at, closed_at, created_at
        ) values (
          ${invVoid}, ${scope.orgId}, ${scope.communityId}, ${newId()}, ${FAKE_ENCRYPTED},
          ${cVoid}, 'void', now() - interval '1 hour', 0, now(), now(), now()
        )
      `;
    });

    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, scope, async (tx) => {
        await expect(purgeDeletedPersons(tx, 50)).resolves.toEqual(
          expect.arrayContaining([cAccepted, cRevoked, cVoid]),
        );
      }),
    );

    const [invA] = await withAppTransaction(
      migrator,
      scope,
      async (tx) =>
        tx<
          { person_id: string | null }[]
        >`select person_id from app.invitations where id = ${invAccepted}`,
    );
    const [invR] = await withAppTransaction(
      migrator,
      scope,
      async (tx) =>
        tx<
          { person_id: string | null }[]
        >`select person_id from app.invitations where id = ${invRevoked}`,
    );
    const [invV] = await withAppTransaction(
      migrator,
      scope,
      async (tx) =>
        tx<
          { person_id: string | null }[]
        >`select person_id from app.invitations where id = ${invVoid}`,
    );
    expect(invA?.person_id).toBeNull();
    expect(invR?.person_id).toBeNull();
    expect(invV?.person_id).toBeNull();

    expect(await getPerson(scope, cAccepted)).toBeUndefined();
    expect(await getPerson(scope, cRevoked)).toBeUndefined();
    expect(await getPerson(scope, cVoid)).toBeUndefined();
  });

  it("purge skips the only guardian of a child", async () => {
    const scope = await setupTenant("p20");
    const soleGuardian = await insertAdult(scope, "Sole", "Guardian");
    await agePerson(scope, soleGuardian, 721);

    const eligible = await insertAdult(scope, "Eligible", "Person");
    await agePerson(scope, eligible, 721);

    const { minorId, householdId } = await insertMinor(scope);

    await withAppTransaction(migrator, scope, async (tx) => {
      await tx`
        insert into app.guardian_links (
          id, org_id, community_id, household_id, guardian_person_id, child_person_id, consent, pickup, view, manage
        ) values (
          ${newId()}, ${scope.orgId}, ${scope.communityId}, ${householdId}, ${soleGuardian}, ${minorId}, true, true, true, true
        )
      `;
    });

    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, scope, async (tx) => {
        await expect(purgeDeletedPersons(tx, 50)).resolves.toEqual([eligible]);
      }),
    );

    const survivor = await getPerson(scope, soleGuardian);
    expect(survivor).toBeDefined();

    const purged = await getPerson(scope, eligible);
    expect(purged).toBeUndefined();
  });

  it("purge deletes a contact who is one of two unhidden guardians", async () => {
    const scope = await setupTenant("two-guardians");
    const guardian1 = await insertAdult(scope, "Guardian", "One");
    await agePerson(scope, guardian1, 721);

    const guardian2 = await insertAdult(scope, "Guardian", "Two"); // visible

    const { minorId, householdId } = await insertMinor(scope);

    const link1Id = newId();
    const link2Id = newId();
    await withAppTransaction(migrator, scope, async (tx) => {
      await tx`
        insert into app.guardian_links (
          id, org_id, community_id, household_id, guardian_person_id, child_person_id, consent, pickup, view, manage
        ) values
          (${link1Id}, ${scope.orgId}, ${scope.communityId}, ${householdId}, ${guardian1}, ${minorId}, true, true, true, true),
          (${link2Id}, ${scope.orgId}, ${scope.communityId}, ${householdId}, ${guardian2}, ${minorId}, true, true, true, true)
      `;
    });

    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, scope, async (tx) => {
        await expect(purgeDeletedPersons(tx, 50)).resolves.toEqual([guardian1]);
      }),
    );

    expect(await getPerson(scope, guardian1)).toBeUndefined();
    expect(await getPerson(scope, guardian2)).toBeDefined();

    const [link2] = await withAppTransaction(
      migrator,
      scope,
      async (tx) =>
        tx<{ id: string }[]>`select id::text as id from app.guardian_links where id = ${link2Id}`,
    );
    expect(link2).toBeDefined();

    const [link1] = await withAppTransaction(
      migrator,
      scope,
      async (tx) =>
        tx<{ id: string }[]>`select id::text as id from app.guardian_links where id = ${link1Id}`,
    );
    expect(link1).toBeUndefined();
  });

  it("purge deletes memberships, guardian links, tags, history and life events", async () => {
    const scope = await setupTenant("p21");
    const contact = await insertAdult(scope, "Full", "Dependants");
    await agePerson(scope, contact, 721);

    const otherGuardian = await insertAdult(scope, "Other", "Guardian");
    const { minorId, householdId } = await insertMinor(scope);

    const groupId = newId();
    const tagId = newId();
    const activityId = newId();
    const lifeEventId = newId();
    const guardianLinkId = newId();

    await withAppTransaction(migrator, scope, async (tx) => {
      // Group & membership
      await tx`
        insert into app.groups (id, org_id, community_id, name, name_key, kind, status, created_at, updated_at)
        values (${groupId}, ${scope.orgId}, ${scope.communityId}, 'Test Group', ${`test-${groupId}`}, 'group', 'active', now(), now())
      `;
      await tx`
        insert into app.group_members (org_id, community_id, group_id, person_id, role, added_at)
        values (${scope.orgId}, ${scope.communityId}, ${groupId}, ${contact}, 'member', now())
      `;

      // Guardian links (contact + other guardian for the child)
      await tx`
        insert into app.guardian_links (id, org_id, community_id, household_id, guardian_person_id, child_person_id, consent, pickup, view, manage)
        values
          (${guardianLinkId}, ${scope.orgId}, ${scope.communityId}, ${householdId}, ${contact}, ${minorId}, true, true, true, true),
          (${newId()}, ${scope.orgId}, ${scope.communityId}, ${householdId}, ${otherGuardian}, ${minorId}, true, true, true, true)
      `;

      // Tag & tag link
      await tx`
        insert into app.person_tags (id, org_id, community_id, label)
        values (${tagId}, ${scope.orgId}, ${scope.communityId}, 'test-tag')
      `;
      await tx`
        insert into app.person_tag_links (org_id, community_id, person_id, tag_id)
        values (${scope.orgId}, ${scope.communityId}, ${contact}, ${tagId})
      `;

      // Activity
      await tx`
        insert into app.person_activity (id, org_id, community_id, person_id, kind, occurred_at)
        values (${activityId}, ${scope.orgId}, ${scope.communityId}, ${contact}, 'created', now())
      `;

      // Life event
      await tx`
        insert into app.life_events (id, org_id, community_id, person_id, version, event_type, event_date)
        values (${lifeEventId}, ${scope.orgId}, ${scope.communityId}, ${contact}, 1, ${FAKE_ENCRYPTED}, ${FAKE_ENCRYPTED})
      `;
    });

    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, scope, async (tx) => {
        await expect(purgeDeletedPersons(tx, 50)).resolves.toEqual([contact]);
      }),
    );

    expect(await getPerson(scope, contact)).toBeUndefined();

    // Verify all dependants are deleted
    const [gm] = await withAppTransaction(
      migrator,
      scope,
      async (tx) => tx`select * from app.group_members where person_id = ${contact}`,
    );
    expect(gm).toBeUndefined();

    const [gl] = await withAppTransaction(
      migrator,
      scope,
      async (tx) => tx`select * from app.guardian_links where guardian_person_id = ${contact}`,
    );
    expect(gl).toBeUndefined();

    const [tl] = await withAppTransaction(
      migrator,
      scope,
      async (tx) => tx`select * from app.person_tag_links where person_id = ${contact}`,
    );
    expect(tl).toBeUndefined();

    const [act] = await withAppTransaction(
      migrator,
      scope,
      async (tx) => tx`select * from app.person_activity where person_id = ${contact}`,
    );
    expect(act).toBeUndefined();

    const [le] = await withAppTransaction(
      migrator,
      scope,
      async (tx) => tx`select * from app.life_events where person_id = ${contact}`,
    );
    expect(le).toBeUndefined();
  });

  it("purge skips a contact another transaction has locked", async () => {
    const scope = await setupTenant("p22");
    const contactLocked = await insertAdult(scope, "Locked", "Person");
    await agePerson(scope, contactLocked, 721);

    const contactUnlocked = await insertAdult(scope, "Unlocked", "Person");
    await agePerson(scope, contactUnlocked, 721);

    const app2 = createPlaintextAppSql(roleUrl(runtime, "app"));
    let releaseLock: (() => void) | undefined;
    const lockHeld = new Promise<void>((resolve) => {
      void withAppTransaction(app, scope, async (tx1) => {
        await tx1`select id from app.persons where id = ${contactLocked} for update`;
        resolve();
        await new Promise<void>((done) => {
          releaseLock = done;
        });
      });
    });

    await lockHeld;

    try {
      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app2, scope, async (tx2) => {
          await tx2.unsafe("set local lock_timeout = '1s'");
          await expect(purgeDeletedPersons(tx2, 50)).resolves.toEqual([contactUnlocked]);
        }),
      );
    } finally {
      releaseLock?.();
      await app2.end({ timeout: 1 });
    }

    const survivor = await getPerson(scope, contactLocked);
    expect(survivor).toBeDefined();

    const purged = await getPerson(scope, contactUnlocked);
    expect(purged).toBeUndefined();
  });

  it("purge writes one people.person.purged event with all purged ids", async () => {
    const scope = await setupTenant("p23");
    const ids: string[] = [];
    for (let i = 0; i < 50; i += 1) {
      ids.push(newId());
    }

    const deletedBy = newId();
    await withAppTransaction(migrator, scope, async (tx) => {
      for (const id of ids) {
        await tx`
          insert into app.persons (id, org_id, community_id, version, is_minor, age_basis, given_name, family_name)
          values (${id}, ${scope.orgId}, ${scope.communityId}, 1, false, 'declared_adult', 'Bulk', 'Test')
        `;
      }
      await tx.unsafe("ALTER TABLE app.persons DISABLE TRIGGER USER");
      await tx`
        update app.persons
        set deleted_at = now() - interval '721 hours',
            deleted_by = ${deletedBy}
        where id = any(${ids}::uuid[])
      `;
      await tx.unsafe("ALTER TABLE app.persons ENABLE TRIGGER USER");
    });

    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, scope, async (tx) => {
        await expect(purgeDeletedPersons(tx, 50)).resolves.toEqual(expect.arrayContaining(ids));
      }),
    );

    const events = await withAppTransaction(migrator, scope, async (tx) => {
      return tx<{ actor_kind: string; actor_id: string | null; target_ids: string[] }[]>`
        select actor_kind, actor_id, target_ids
        from app.audit_events
        where action = 'people.person.purged'
          and org_id = ${scope.orgId}
      `;
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.actor_kind).toBe("system");
    expect(events[0]?.actor_id).toBeNull();
    expect(events[0]?.target_ids.slice().sort()).toEqual(ids.slice().sort());
  });

  it("every foreign key to app.persons is handled by the purge", async () => {
    const fkTables = await getFkReferencingPersons(migrator);
    const handled = await getHandledTablesFromFunctionDef(migrator);
    const unhandled = fkTables.filter((t) => !handled.has(t));
    expect(unhandled).toEqual([]);
  });

  it("reports an unhandled foreign key to app.persons in probe table", async () => {
    await migrator.begin(async (tx) => {
      await tx.unsafe(`
        create table app.zz_probe (
          org_id uuid not null,
          id uuid not null,
          person_id uuid not null,
          constraint zz_probe_fk foreign key (org_id, person_id) references app.persons(org_id, id)
        )
      `);
      try {
        const fkTables = await getFkReferencingPersons(tx);
        const handled = await getHandledTablesFromFunctionDef(tx);
        const unhandled = fkTables.filter((t) => !handled.has(t));
        expect(unhandled).toContain("zz_probe");
      } finally {
        await tx.unsafe("drop table app.zz_probe");
      }
    });
  });
});
