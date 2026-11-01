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

import {
  createHousehold,
  createPerson,
  linkGuardian,
  unlinkGuardian,
  PeopleError,
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
const REQUEST_ID = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2026-10-11T00:00:00+11:00");

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

async function withTenant(
  slug: string,
  run: (tx: AppTransaction, kms: ReturnType<typeof createLocalKmsPort>) => Promise<void>,
): Promise<void> {
  const runtime = loadRuntime();
  const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
  const app = createPlaintextAppSql(roleUrl(runtime, "app"));
  const organisationId = newId();
  const communityId = newId();
  const kms = createLocalKmsPort();
  try {
    const tenantSlug = `${slug.slice(0, 20)}-${organisationId.slice(0, 8)}`;
    await platform.begin(async (tx) => {
      await tx`
        insert into platform.organisations (id, slug, region, kind)
        values (${organisationId}, ${tenantSlug}, 'au', 'implicit')
      `;
      await tx`
        insert into platform.communities (id, organisation_id, slug, region)
        values (${communityId}, ${organisationId}, ${tenantSlug}, 'au')
      `;
    });
    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, { orgId: organisationId, communityId }, (tx) => run(tx, kms)),
    );
  } finally {
    await platform.end({ timeout: 1 });
    await app.end({ timeout: 1 });
  }
}

describe("guardian links", () => {
  it("links an adult to a minor in the same household", async () => {
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
          values (${organisationId}, 'guardian-parish', 'au', 'implicit')
        `;
        await tx`
          insert into platform.communities (id, organisation_id, slug, region)
          values (${communityId}, ${organisationId}, 'guardian-parish', 'au')
        `;
      });

      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, { orgId: organisationId, communityId }, async (tx) => {
          const household = await createHousehold(tx, kms, KEY_ARN, {
            now: NOW,
            label: null,
            actorUserId: null,
          });
          const adult = await createPerson(tx, kms, KEY_ARN, {
            now: NOW,
            declaredAdult: false,
            householdId: household.householdId,
            dateOfBirth: "2008-10-11",
            givenName: "Ada",
            familyName: "Example",
            email: null,
            phone: null,
            actorUserId: null,
          });
          const minor = await createPerson(tx, kms, KEY_ARN, {
            now: NOW,
            declaredAdult: false,
            householdId: household.householdId,
            dateOfBirth: null,
            givenName: "Ned",
            familyName: "Example",
            email: null,
            phone: null,
            actorUserId: null,
          });

          const linked = await linkGuardian(tx, {
            now: NOW,
            householdId: household.householdId,
            guardianPersonId: adult.personId,
            childPersonId: minor.personId,
            consent: true,
            pickup: false,
            view: false,
            manage: false,
            actorUserId: null,
          });
          const stored = await tx<
            { consent: boolean; pickup: boolean; view: boolean; manage: boolean }[]
          >`
            select consent, pickup, view, manage
            from app.guardian_links
            where id = ${linked.linkId}::uuid
          `;
          expect(stored).toEqual([{ consent: true, pickup: false, view: false, manage: false }]);
          const linkedActivity = await tx<{ kind: string }[]>`
            select kind from app.person_activity
            where person_id = ${minor.personId}::uuid and kind = 'guardian_linked'
          `;
          expect(linkedActivity).toEqual([{ kind: "guardian_linked" }]);

          await expect(
            linkGuardian(tx, {
              now: NOW,
              householdId: household.householdId,
              guardianPersonId: minor.personId,
              childPersonId: adult.personId,
              consent: true,
              pickup: false,
              view: false,
              manage: false,
              actorUserId: null,
            }),
          ).rejects.toMatchObject({ code: "invalid_guardian" });
          const links = await tx<{ n: number }[]>`
            select count(*)::int as n from app.guardian_links
          `;
          expect(links).toEqual([{ n: 1 }]);

          await expect(
            linkGuardian(tx, {
              now: NOW,
              householdId: household.householdId,
              guardianPersonId: adult.personId,
              childPersonId: minor.personId,
              consent: true,
              pickup: false,
              view: false,
              manage: false,
              actorUserId: null,
            }),
          ).rejects.toMatchObject({ code: "duplicate_guardian_link" });

          await expect(
            linkGuardian(tx, {
              now: NOW,
              householdId: household.householdId,
              guardianPersonId: adult.personId,
              childPersonId: minor.personId,
              consent: false,
              pickup: false,
              view: false,
              manage: false,
              actorUserId: null,
            }),
          ).rejects.toMatchObject({ code: "invalid_guardian" });
          const stillOne = await tx<{ n: number }[]>`
            select count(*)::int as n from app.guardian_links
          `;
          expect(stillOne).toEqual([{ n: 1 }]);

          const bob = await createPerson(tx, kms, KEY_ARN, {
            now: NOW,
            declaredAdult: false,
            householdId: household.householdId,
            dateOfBirth: "2007-05-01",
            givenName: "Bob",
            familyName: "Example",
            email: null,
            phone: null,
            actorUserId: null,
          });
          const bobLinked = await linkGuardian(tx, {
            now: NOW,
            householdId: household.householdId,
            guardianPersonId: bob.personId,
            childPersonId: minor.personId,
            consent: true,
            pickup: false,
            view: false,
            manage: false,
            actorUserId: null,
          });

          await unlinkGuardian(tx, {
            now: NOW,
            householdId: household.householdId,
            linkId: linked.linkId,
            actorUserId: null,
          });
          const unlinked = await tx<{ kind: string }[]>`
            select kind from app.person_activity
            where person_id = ${minor.personId}::uuid and kind = 'guardian_unlinked'
          `;
          expect(unlinked).toEqual([{ kind: "guardian_unlinked" }]);

          await expect(
            unlinkGuardian(tx, {
              now: NOW,
              householdId: household.householdId,
              linkId: bobLinked.linkId,
              actorUserId: null,
            }),
          ).rejects.toMatchObject({ code: "last_guardian" });

          await expect(
            unlinkGuardian(tx, {
              now: NOW,
              householdId: household.householdId,
              linkId: linked.linkId,
              actorUserId: null,
            }),
          ).rejects.toMatchObject({ code: "not_found" });
          const unlinkedAgain = await tx<{ n: number }[]>`
            select count(*)::int as n
            from app.person_activity
            where person_id = ${minor.personId}::uuid and kind = 'guardian_unlinked'
          `;
          expect(unlinkedAgain).toEqual([{ n: 1 }]);
        }),
      );
    } finally {
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
    }
  });

  it("rejects a minor guardian and a household that does not match", async () => {
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
          values (${organisationId}, 'guardian-rule-parish', 'au', 'implicit')
        `;
        await tx`
          insert into platform.communities (id, organisation_id, slug, region)
          values (${communityId}, ${organisationId}, 'guardian-rule-parish', 'au')
        `;
      });

      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, { orgId: organisationId, communityId }, async (tx) => {
          const home = await createHousehold(tx, kms, KEY_ARN, {
            now: NOW,
            label: null,
            actorUserId: null,
          });
          const other = await createHousehold(tx, kms, KEY_ARN, {
            now: NOW,
            label: null,
            actorUserId: null,
          });
          const adult = await createPerson(tx, kms, KEY_ARN, {
            now: NOW,
            declaredAdult: false,
            householdId: home.householdId,
            dateOfBirth: "2008-10-11",
            givenName: "Ada",
            familyName: "Example",
            email: null,
            phone: null,
            actorUserId: null,
          });
          const child = await createPerson(tx, kms, KEY_ARN, {
            now: NOW,
            declaredAdult: false,
            householdId: home.householdId,
            dateOfBirth: null,
            givenName: "Ned",
            familyName: "Example",
            email: null,
            phone: null,
            actorUserId: null,
          });
          const minorGuardian = await createPerson(tx, kms, KEY_ARN, {
            now: NOW,
            declaredAdult: false,
            householdId: home.householdId,
            dateOfBirth: null,
            givenName: "Bea",
            familyName: "Example",
            email: null,
            phone: null,
            actorUserId: null,
          });
          const otherChild = await createPerson(tx, kms, KEY_ARN, {
            now: NOW,
            declaredAdult: false,
            householdId: other.householdId,
            dateOfBirth: null,
            givenName: "Cara",
            familyName: "Example",
            email: null,
            phone: null,
            actorUserId: null,
          });

          await expect(
            linkGuardian(tx, {
              now: NOW,
              householdId: home.householdId,
              guardianPersonId: minorGuardian.personId,
              childPersonId: child.personId,
              consent: true,
              pickup: false,
              view: false,
              manage: false,
              actorUserId: null,
            }),
          ).rejects.toMatchObject({ code: "invalid_guardian" });

          await expect(
            linkGuardian(tx, {
              now: NOW,
              householdId: other.householdId,
              guardianPersonId: adult.personId,
              childPersonId: otherChild.personId,
              consent: true,
              pickup: false,
              view: false,
              manage: false,
              actorUserId: null,
            }),
          ).rejects.toMatchObject({ code: "invalid_guardian" });

          await expect(
            linkGuardian(tx, {
              now: NOW,
              householdId: other.householdId,
              guardianPersonId: adult.personId,
              childPersonId: child.personId,
              consent: true,
              pickup: false,
              view: false,
              manage: false,
              actorUserId: null,
            }),
          ).rejects.toMatchObject({ code: "invalid_guardian" });

          const links = await tx<{ n: number }[]>`
            select count(*)::int as n from app.guardian_links
          `;
          expect(links).toEqual([{ n: 0 }]);
          const activity = await tx<{ n: number }[]>`
            select count(*)::int as n
            from app.person_activity
            where kind = 'guardian_linked'
          `;
          expect(activity).toEqual([{ n: 0 }]);
        }),
      );
    } finally {
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
    }
  });
  it("rejects an adult as the child, even when both are in the named household", async () => {
    await withTenant("guardian-adult-child-parish", async (tx, kms) => {
      const home = await createHousehold(tx, kms, KEY_ARN, {
        now: NOW,
        label: null,
        actorUserId: null,
      });
      const guardian = await createPerson(tx, kms, KEY_ARN, {
        now: NOW,
        declaredAdult: false,
        householdId: home.householdId,
        dateOfBirth: "2008-10-11",
        givenName: "Ada",
        familyName: "Example",
        email: null,
        phone: null,
        actorUserId: null,
      });
      const adultChild = await createPerson(tx, kms, KEY_ARN, {
        now: NOW,
        declaredAdult: false,
        householdId: home.householdId,
        dateOfBirth: "2000-01-02",
        givenName: "Ben",
        familyName: "Example",
        email: null,
        phone: null,
        actorUserId: null,
      });
      const stored = await tx<{ id: string; is_minor: boolean }[]>`
        select id::text as id, is_minor from app.persons
        where id in (${guardian.personId}::uuid, ${adultChild.personId}::uuid)
      `;
      expect(stored.map((row) => row.is_minor)).toEqual([false, false]);

      await expect(
        linkGuardian(tx, {
          now: NOW,
          householdId: home.householdId,
          guardianPersonId: guardian.personId,
          childPersonId: adultChild.personId,
          consent: true,
          pickup: false,
          view: false,
          manage: false,
          actorUserId: null,
        }),
      ).rejects.toMatchObject({ code: "invalid_guardian" });
      const links = await tx<{ n: number }[]>`
        select count(*)::int as n from app.guardian_links
      `;
      expect(links).toEqual([{ n: 0 }]);
    });
  });

  it("rejects a child who lives in a different household from the named one", async () => {
    await withTenant("guardian-other-home-parish", async (tx, kms) => {
      const home = await createHousehold(tx, kms, KEY_ARN, {
        now: NOW,
        label: null,
        actorUserId: null,
      });
      const elsewhere = await createHousehold(tx, kms, KEY_ARN, {
        now: NOW,
        label: null,
        actorUserId: null,
      });
      const guardian = await createPerson(tx, kms, KEY_ARN, {
        now: NOW,
        declaredAdult: false,
        householdId: home.householdId,
        dateOfBirth: "2008-10-11",
        givenName: "Ada",
        familyName: "Example",
        email: null,
        phone: null,
        actorUserId: null,
      });
      const child = await createPerson(tx, kms, KEY_ARN, {
        now: NOW,
        declaredAdult: false,
        householdId: elsewhere.householdId,
        dateOfBirth: null,
        givenName: "Cara",
        familyName: "Example",
        email: null,
        phone: null,
        actorUserId: null,
      });

      await expect(
        linkGuardian(tx, {
          now: NOW,
          householdId: home.householdId,
          guardianPersonId: guardian.personId,
          childPersonId: child.personId,
          consent: true,
          pickup: false,
          view: false,
          manage: false,
          actorUserId: null,
        }),
      ).rejects.toMatchObject({ code: "invalid_guardian" });
      const links = await tx<{ n: number }[]>`
        select count(*)::int as n from app.guardian_links
      `;
      expect(links).toEqual([{ n: 0 }]);
    });
  });

  it("pin 3: refuses to unlink the last guardian concurrently (race condition)", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const kms = createLocalKmsPort();
    const organisationId = newId();
    const communityId = newId();
    const scope = { orgId: organisationId, communityId };

    try {
      await platform.begin(async (tx) => {
        await tx`
          insert into platform.organisations (id, slug, region, kind)
          values (${organisationId}, ${`pin3-${organisationId}`}, 'au', 'implicit')
        `;
        await tx`
          insert into platform.communities (id, organisation_id, slug, region)
          values (${communityId}, ${organisationId}, ${`pin3-${organisationId}`}, 'au')
        `;
      });

      let householdId!: string;
      let childId!: string;
      let link1Id!: string;
      let link2Id!: string;

      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, scope, async (tx) => {
          const hh = await createHousehold(tx, kms, KEY_ARN, {
            now: NOW,
            label: null,
            actorUserId: null,
          });
          householdId = hh.householdId;

          const g1 = await createPerson(tx, kms, KEY_ARN, {
            now: NOW,
            declaredAdult: false,
            householdId,
            dateOfBirth: "2005-01-01",
            givenName: "AdultOne",
            familyName: "Family",
            email: null,
            phone: null,
            actorUserId: null,
          });
          const g2 = await createPerson(tx, kms, KEY_ARN, {
            now: NOW,
            declaredAdult: false,
            householdId,
            dateOfBirth: "2006-02-02",
            givenName: "AdultTwo",
            familyName: "Family",
            email: null,
            phone: null,
            actorUserId: null,
          });
          const child = await createPerson(tx, kms, KEY_ARN, {
            now: NOW,
            declaredAdult: false,
            householdId,
            dateOfBirth: null,
            givenName: "Child",
            familyName: "Family",
            email: null,
            phone: null,
            actorUserId: null,
          });
          childId = child.personId;

          const l1 = await linkGuardian(tx, {
            now: NOW,
            householdId,
            guardianPersonId: g1.personId,
            childPersonId: child.personId,
            consent: true,
            pickup: false,
            view: false,
            manage: false,
            actorUserId: null,
          });
          link1Id = l1.linkId;

          const l2 = await linkGuardian(tx, {
            now: NOW,
            householdId,
            guardianPersonId: g2.personId,
            childPersonId: child.personId,
            consent: true,
            pickup: false,
            view: false,
            manage: false,
            actorUserId: null,
          });
          link2Id = l2.linkId;
        }),
      );

      // Verify setup: child has 2 links
      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, scope, async (tx) => {
          const links = await tx<{ id: string }[]>`
            select id::text as id from app.guardian_links where child_person_id = ${childId}::uuid
          `;
          expect(links).toHaveLength(2);
        }),
      );

      // Deterministic race test
      let releaseTx1!: () => void;
      const tx1Hold = new Promise<void>((resolve) => {
        releaseTx1 = resolve;
      });
      let tx1Started = false;

      const p1 = withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, scope, async (tx1) => {
          await unlinkGuardian(tx1, {
            now: NOW,
            householdId,
            linkId: link1Id,
            actorUserId: null,
          });
          tx1Started = true;
          await tx1Hold;
        }),
      );

      while (!tx1Started) {
        await new Promise((resolve) => setImmediate(resolve));
      }

      let tx2Pid: number | null = null;
      let tx2Error: unknown = null;

      const p2 = withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, scope, async (tx2) => {
          const pidRows = await tx2<{ pid: number }[]>`select pg_backend_pid() as pid`;
          tx2Pid = pidRows[0]!.pid;
          await unlinkGuardian(tx2, {
            now: NOW,
            householdId,
            linkId: link2Id,
            actorUserId: null,
          });
        }),
      ).catch((err) => {
        tx2Error = err;
      });

      const start = Date.now();
      let locked = false;
      while (Date.now() - start < 10000) {
        if (tx2Pid !== null) {
          const stat = await directSql<{ wait_event_type: string | null }[]>`
            select wait_event_type from pg_stat_activity where pid = ${tx2Pid}
          `;
          if (stat[0]?.wait_event_type === "Lock") {
            locked = true;
            break;
          }
        }
        await new Promise((resolve) => setImmediate(resolve));
      }

      expect(locked).toBe(true);

      releaseTx1();
      await p1;
      await p2;

      expect(tx2Error).toBeInstanceOf(PeopleError);
      expect((tx2Error as PeopleError).code).toBe("last_guardian");

      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, scope, async (tx) => {
          const remaining = await tx<{ id: string }[]>`
            select id::text as id from app.guardian_links where child_person_id = ${childId}::uuid
          `;
          expect(remaining).toHaveLength(1);
          expect(remaining[0]!.id).toBe(link2Id);
        }),
      );
    } finally {
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
      await directSql.end({ timeout: 1 });
    }
  });

  it("pin 4: refuses to unlink when householdId does not match the link's household", async () => {
    await withTenant("pin4-household-mismatch", async (tx, kms) => {
      const homeA = await createHousehold(tx, kms, KEY_ARN, {
        now: NOW,
        label: null,
        actorUserId: null,
      });
      const homeB = await createHousehold(tx, kms, KEY_ARN, {
        now: NOW,
        label: null,
        actorUserId: null,
      });
      const adultB = await createPerson(tx, kms, KEY_ARN, {
        now: NOW,
        declaredAdult: false,
        householdId: homeB.householdId,
        dateOfBirth: "2005-01-01",
        givenName: "Adult",
        familyName: "Person",
        email: null,
        phone: null,
        actorUserId: null,
      });
      const minorB = await createPerson(tx, kms, KEY_ARN, {
        now: NOW,
        declaredAdult: false,
        householdId: homeB.householdId,
        dateOfBirth: null,
        givenName: "Minor",
        familyName: "Person",
        email: null,
        phone: null,
        actorUserId: null,
      });
      const link = await linkGuardian(tx, {
        now: NOW,
        householdId: homeB.householdId,
        guardianPersonId: adultB.personId,
        childPersonId: minorB.personId,
        consent: true,
        pickup: false,
        view: false,
        manage: false,
        actorUserId: null,
      });

      await expect(
        unlinkGuardian(tx, {
          now: NOW,
          householdId: homeA.householdId,
          linkId: link.linkId,
          actorUserId: null,
        }),
      ).rejects.toMatchObject({ code: "not_found" });

      const stored = await tx<{ id: string }[]>`
        select id::text as id from app.guardian_links where id = ${link.linkId}::uuid
      `;
      expect(stored).toHaveLength(1);
    });
  });

  it("pin 12: cross-organisation and cross-community guardian unlink is isolated", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const kms = createLocalKmsPort();
    const orgA = newId();
    const commA = newId();
    const orgB = newId();
    const commB = newId();

    try {
      await platform.begin(async (tx) => {
        await tx`insert into platform.organisations (id, slug, region, kind) values (${orgA}, ${`org-a-${orgA}`}, 'au', 'implicit')`;
        await tx`insert into platform.communities (id, organisation_id, slug, region) values (${commA}, ${orgA}, ${`comm-a-${commA}`}, 'au')`;
        await tx`insert into platform.organisations (id, slug, region, kind) values (${orgB}, ${`org-b-${orgB}`}, 'au', 'implicit')`;
        await tx`insert into platform.communities (id, organisation_id, slug, region) values (${commB}, ${orgB}, ${`comm-b-${commB}`}, 'au')`;
      });

      let linkIdA!: string;
      let homeA!: string;

      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, { orgId: orgA, communityId: commA }, async (tx) => {
          const hh = await createHousehold(tx, kms, KEY_ARN, {
            now: NOW,
            label: null,
            actorUserId: null,
          });
          homeA = hh.householdId;
          const a = await createPerson(tx, kms, KEY_ARN, {
            now: NOW,
            declaredAdult: true,
            householdId: homeA,
            dateOfBirth: null,
            givenName: "A",
            familyName: "A",
            email: null,
            phone: null,
            actorUserId: null,
          });
          const m = await createPerson(tx, kms, KEY_ARN, {
            now: NOW,
            declaredAdult: false,
            householdId: homeA,
            dateOfBirth: null,
            givenName: "M",
            familyName: "M",
            email: null,
            phone: null,
            actorUserId: null,
          });
          const l = await linkGuardian(tx, {
            now: NOW,
            householdId: homeA,
            guardianPersonId: a.personId,
            childPersonId: m.personId,
            consent: true,
            pickup: false,
            view: false,
            manage: false,
            actorUserId: null,
          });
          linkIdA = l.linkId;
        }),
      );

      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, { orgId: orgB, communityId: commB }, async (tx) => {
          await expect(
            unlinkGuardian(tx, {
              now: NOW,
              householdId: homeA,
              linkId: linkIdA,
              actorUserId: null,
            }),
          ).rejects.toMatchObject({ code: "not_found" });
        }),
      );
    } finally {
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
    }
  });

  it("pin 24: link and unlink write audit events with ids only and no names or labels", async () => {
    await withTenant("pin24-guardian-audit", async (tx, kms) => {
      const home = await createHousehold(tx, kms, KEY_ARN, {
        now: NOW,
        label: "SecretFamilyLabel",
        actorUserId: null,
      });
      const adult1 = await createPerson(tx, kms, KEY_ARN, {
        now: NOW,
        declaredAdult: true,
        householdId: home.householdId,
        dateOfBirth: null,
        givenName: "SuperSecretAdult1",
        familyName: "SuperSecretFamily",
        email: null,
        phone: null,
        actorUserId: null,
      });
      const adult2 = await createPerson(tx, kms, KEY_ARN, {
        now: NOW,
        declaredAdult: true,
        householdId: home.householdId,
        dateOfBirth: null,
        givenName: "SuperSecretAdult2",
        familyName: "SuperSecretFamily",
        email: null,
        phone: null,
        actorUserId: null,
      });
      const child = await createPerson(tx, kms, KEY_ARN, {
        now: NOW,
        declaredAdult: false,
        householdId: home.householdId,
        dateOfBirth: null,
        givenName: "SuperSecretChild",
        familyName: "SuperSecretFamily",
        email: null,
        phone: null,
        actorUserId: null,
      });

      const l1 = await linkGuardian(tx, {
        now: NOW,
        householdId: home.householdId,
        guardianPersonId: adult1.personId,
        childPersonId: child.personId,
        consent: true,
        pickup: false,
        view: false,
        manage: false,
        actorUserId: "11111111-1111-4111-8111-111111111111",
      });

      const l2 = await linkGuardian(tx, {
        now: NOW,
        householdId: home.householdId,
        guardianPersonId: adult2.personId,
        childPersonId: child.personId,
        consent: true,
        pickup: false,
        view: false,
        manage: false,
        actorUserId: "11111111-1111-4111-8111-111111111111",
      });

      const linkAudits = await tx<{ action: string; target_ids: string[] }[]>`
        select action, target_ids from app.audit_events
        where action = 'people.guardian.linked'
      `;
      expect(linkAudits).toHaveLength(2);
      expect(linkAudits[0]!.target_ids).toContain(l1.linkId);
      expect(linkAudits[1]!.target_ids).toContain(l2.linkId);

      await unlinkGuardian(tx, {
        now: NOW,
        householdId: home.householdId,
        linkId: l1.linkId,
        actorUserId: "22222222-2222-4222-8222-222222222222",
      });

      const unlinkAudits = await tx<{ action: string; target_ids: string[] }[]>`
        select action, target_ids from app.audit_events
        where action = 'people.guardian.unlinked'
      `;
      expect(unlinkAudits).toHaveLength(1);
      expect(unlinkAudits[0]!.target_ids).toContain(l1.linkId);

      const allAuditRows = await tx<{ action: string }[]>`
        select action from app.audit_events
      `;
      const stringified = JSON.stringify(allAuditRows);
      expect(stringified).not.toContain("SecretFamilyLabel");
      expect(stringified).not.toContain("SuperSecretAdult1");
      expect(stringified).not.toContain("SuperSecretAdult2");
      expect(stringified).not.toContain("SuperSecretChild");
      expect(stringified).not.toContain("SuperSecretFamily");
    });
  });
});
