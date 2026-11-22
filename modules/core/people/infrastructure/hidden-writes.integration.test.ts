import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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
  addAdult,
  addMinor,
  attachTag,
  createHousehold,
  createLifeEvent,
  createPerson,
  createTag,
  detachTag,
  hidePerson,
  linkGuardian,
  listPersonActivity,
  listPersonTags,
  lockPersonForDelete,
  moveAdult,
  setPersonStatus,
  unlinkGuardian,
  updateLifeEvent,
  updatePerson,
} from "../public/index.js";

type Runtime = {
  productOnlyUrl: string;
  passwords: { app: string; platform: string };
};

type Scope = { orgId: string; communityId: string };

const RUNTIME = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/db/test/.runtime.json",
);

const KEY_ARN = [
  "arn",
  "aws",
  "kms",
  "ap-southeast-2",
  ["12", "34", "56", "78", "90", "12"].join(""),
  `key/mrk-${"ab".repeat(16)}`,
].join(":");
const REQUEST_ID = "77777777-7777-4777-8777-777777777777";
const NOW = new Date("2026-10-31T00:00:00+11:00");

function loadRuntime(): Runtime {
  return JSON.parse(readFileSync(RUNTIME, "utf8")) as Runtime;
}

function roleUrl(runtime: Runtime, role: "app" | "platform"): string {
  const password = encodeURIComponent(runtime.passwords[role]);
  return `postgres://${role}:${password}@127.0.0.1:5432/hub_product_only`;
}

type PersonRow = {
  version: number;
  status: string;
  given_name: string | null;
  household_id: string | null;
  deleted_at: Date | null;
};

describe("hidden writes", () => {
  let runtime: Runtime;
  let platform: ReturnType<typeof createPlaintextPlatformSql>;
  let app: ReturnType<typeof createPlaintextAppSql>;
  let migrator: ReturnType<typeof createPlaintextDirectSql>;
  const kms = createLocalKmsPort();
  let counter = 0;

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

  async function setupTenant(slugPrefix: string): Promise<Scope> {
    const orgId = newId();
    const communityId = newId();
    await platform.begin(async (tx) => {
      await tx`
        insert into platform.organisations (id, slug, region, kind)
        values (${orgId}, ${`${slugPrefix}-${orgId}`}, 'au', 'implicit')
      `;
      await tx`
        insert into platform.communities (id, organisation_id, slug, region)
        values (${communityId}, ${orgId}, ${`${slugPrefix}-${communityId}`}, 'au')
      `;
    });
    return { orgId, communityId };
  }

  function inScope<T>(scope: Scope, fn: (tx: AppTransaction) => Promise<T>): Promise<T> {
    return withRequest({ requestId: REQUEST_ID }, () => withAppTransaction(app, scope, fn));
  }

  async function addAdultPerson(
    scope: Scope,
    givenName: string,
    familyName: string,
    options: { householdId?: string | null; email?: string | null; phone?: string | null } = {},
  ): Promise<string> {
    counter += 1;
    const n = counter;
    return inScope(scope, async (tx) => {
      const created = await createPerson(tx, kms, KEY_ARN, {
        now: NOW,
        declaredAdult: true,
        householdId: options.householdId ?? null,
        dateOfBirth: null,
        givenName,
        familyName,
        email: options.email === undefined ? `hidden-writes.${n}@example.test` : options.email,
        phone:
          options.phone === undefined ? `+61 422 555 ${String(100 + (n % 900))}` : options.phone,
        actorUserId: null,
      });
      return created.personId;
    });
  }

  async function hide(scope: Scope, personId: string, version = 1): Promise<void> {
    await inScope(scope, async (tx) => {
      await lockPersonForDelete(tx, { personId, version });
      await hidePerson(tx, { personId, actorUserId: newId() });
    });
  }

  async function createHouseholdRow(scope: Scope, label: string): Promise<string> {
    return inScope(scope, async (tx) => {
      const household = await createHousehold(tx, kms, KEY_ARN, {
        now: NOW,
        label,
        actorUserId: null,
      });
      return household.householdId;
    });
  }

  async function personRow(scope: Scope, personId: string): Promise<PersonRow> {
    const rows = await withAppTransaction(migrator, scope, async (tx) => {
      return await tx<PersonRow[]>`
        select version, status, given_name, household_id::text as household_id, deleted_at
        from app.persons
        where id = ${personId}::uuid
      `;
    });
    const row = rows[0];
    if (row === undefined) {
      throw new Error("person row is missing");
    }
    return row;
  }

  async function countRows(
    scope: Scope,
    table: "person_activity" | "person_tag_links" | "life_events" | "guardian_links",
    personColumn: "person_id" | "guardian_person_id" | "child_person_id",
    personId: string,
  ): Promise<number> {
    const rows = await withAppTransaction(migrator, scope, async (tx) => {
      return await tx<{ count: number }[]>`
        select count(*)::int as count
        from ${tx(`app.${table}`)}
        where ${tx(personColumn)} = ${personId}::uuid
      `;
    });
    return rows[0]?.count ?? 0;
  }

  // A child with one visible guardian, so the other guardians under test can be linked and
  // hidden without leaving the child alone.
  async function familyWithChild(
    scope: Scope,
    label: string,
  ): Promise<{ householdId: string; childId: string; baseGuardianId: string }> {
    const householdId = await createHouseholdRow(scope, label);
    const baseGuardianId = await addAdultPerson(scope, "Base", label, { householdId });
    const childId = await inScope(scope, async (tx) => {
      const child = await addMinor(tx, kms, KEY_ARN, {
        now: NOW,
        householdId,
        givenName: "Child",
        familyName: label,
        dateOfBirth: "2018-03-04",
        guardianId: baseGuardianId,
        actorUserId: null,
      });
      return child.personId;
    });
    return { householdId, childId, baseGuardianId };
  }

  async function link(
    scope: Scope,
    householdId: string,
    guardianPersonId: string,
    childPersonId: string,
  ): Promise<string> {
    return inScope(scope, async (tx) => {
      const linked = await linkGuardian(tx, {
        now: NOW,
        householdId,
        guardianPersonId,
        childPersonId,
        consent: true,
        pickup: true,
        view: true,
        manage: true,
        actorUserId: null,
      });
      return linked.linkId;
    });
  }

  it("update answers not found for a hidden contact", async () => {
    const scope = await setupTenant("hw45");
    const visible = await addAdultPerson(scope, "Vera", "Update");
    const hidden = await addAdultPerson(scope, "Hugo", "Update");
    await hide(scope, hidden);

    await expect(
      inScope(scope, (tx) =>
        updatePerson(tx, kms, KEY_ARN, {
          personId: hidden,
          version: 2,
          changes: { givenName: "Changed" },
          actorUserId: null,
        }),
      ),
    ).rejects.toMatchObject({ code: "not_found" });

    const after = await personRow(scope, hidden);
    expect(after.given_name).toBe("Hugo");
    expect(after.version).toBe(2);
    expect(after.deleted_at).not.toBeNull();

    await expect(
      inScope(scope, (tx) =>
        updatePerson(tx, kms, KEY_ARN, {
          personId: visible,
          version: 1,
          changes: { givenName: "Changed" },
          actorUserId: null,
        }),
      ),
    ).resolves.toEqual({ version: 2 });
  });

  it("status answers not found for a hidden contact", async () => {
    const scope = await setupTenant("hw46");
    const visible = await addAdultPerson(scope, "Vera", "Status");
    const hidden = await addAdultPerson(scope, "Hugo", "Status");
    await hide(scope, hidden);

    await expect(
      inScope(scope, (tx) =>
        setPersonStatus(tx, {
          personId: hidden,
          version: 2,
          status: "inactive",
          actorUserId: null,
        }),
      ),
    ).rejects.toMatchObject({ code: "not_found" });

    const after = await personRow(scope, hidden);
    expect(after.status).toBe("active");
    expect(after.version).toBe(2);

    await expect(
      inScope(scope, (tx) =>
        setPersonStatus(tx, {
          personId: visible,
          version: 1,
          status: "inactive",
          actorUserId: null,
        }),
      ),
    ).resolves.toEqual({ version: 2, status: "inactive" });
  });

  it("moveAdult answers not found for a hidden contact", async () => {
    const scope = await setupTenant("hw47");
    const from = await createHouseholdRow(scope, "From Family");
    const target = await createHouseholdRow(scope, "Target Family");
    const visible = await addAdultPerson(scope, "Vera", "Mover", { householdId: from });
    const hidden = await addAdultPerson(scope, "Hugo", "Mover", { householdId: from });
    await hide(scope, hidden);

    await expect(
      inScope(scope, (tx) =>
        moveAdult(tx, { personId: hidden, version: 2, householdId: target, actorUserId: null }),
      ),
    ).rejects.toMatchObject({ code: "not_found" });

    const after = await personRow(scope, hidden);
    expect(after.household_id).toBe(from);
    expect(after.version).toBe(2);

    await expect(
      inScope(scope, (tx) =>
        moveAdult(tx, { personId: visible, version: 1, householdId: target, actorUserId: null }),
      ),
    ).resolves.toEqual({ version: 2 });
  });

  it("linkGuardian answers not found for a hidden contact", async () => {
    const scope = await setupTenant("hw48");
    const { householdId, childId } = await familyWithChild(scope, "Linker");
    const visible = await addAdultPerson(scope, "Vera", "Linker", { householdId });
    const hidden = await addAdultPerson(scope, "Hugo", "Linker", { householdId });
    await hide(scope, hidden);

    await expect(
      inScope(scope, (tx) =>
        linkGuardian(tx, {
          now: NOW,
          householdId,
          guardianPersonId: hidden,
          childPersonId: childId,
          consent: true,
          pickup: true,
          view: true,
          manage: true,
          actorUserId: null,
        }),
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(await countRows(scope, "guardian_links", "guardian_person_id", hidden)).toBe(0);

    await expect(link(scope, householdId, visible, childId)).resolves.toEqual(expect.any(String));
    expect(await countRows(scope, "guardian_links", "guardian_person_id", visible)).toBe(1);
  });

  it("unlinkGuardian answers not found for a hidden guardian", async () => {
    const scope = await setupTenant("hw49");
    const { householdId, childId } = await familyWithChild(scope, "Unlinker");
    const other = await addAdultPerson(scope, "Hugo", "Unlinker", { householdId });
    const otherLink = await link(scope, householdId, other, childId);
    await hide(scope, other);

    await expect(
      inScope(scope, (tx) =>
        unlinkGuardian(tx, { now: NOW, householdId, linkId: otherLink, actorUserId: null }),
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(await countRows(scope, "guardian_links", "guardian_person_id", other)).toBe(1);
  });

  it("unlinking the last unhidden guardian answers last_guardian", async () => {
    const scope = await setupTenant("hw50");
    const { householdId, childId, baseGuardianId } = await familyWithChild(scope, "Lastone");
    const hiddenGuardian = await addAdultPerson(scope, "Hugo", "Lastone", { householdId });
    await link(scope, householdId, hiddenGuardian, childId);
    await hide(scope, hiddenGuardian);
    const baseLinks = await withAppTransaction(migrator, scope, async (tx) => {
      return await tx<{ id: string }[]>`
        select id::text as id
        from app.guardian_links
        where guardian_person_id = ${baseGuardianId}::uuid
      `;
    });
    const baseLink = baseLinks[0]?.id;
    expect(baseLink).toBeDefined();

    await expect(
      inScope(scope, (tx) =>
        unlinkGuardian(tx, { now: NOW, householdId, linkId: baseLink ?? "", actorUserId: null }),
      ),
    ).rejects.toMatchObject({ code: "last_guardian" });
    expect(await countRows(scope, "guardian_links", "guardian_person_id", baseGuardianId)).toBe(1);

    // A second unhidden guardian makes the same unlink legal.
    const second = await addAdultPerson(scope, "Vera", "Lastone", { householdId });
    await link(scope, householdId, second, childId);
    await expect(
      inScope(scope, (tx) =>
        unlinkGuardian(tx, { now: NOW, householdId, linkId: baseLink ?? "", actorUserId: null }),
      ),
    ).resolves.toBeUndefined();
    expect(await countRows(scope, "guardian_links", "guardian_person_id", baseGuardianId)).toBe(0);
  });

  it("attachTag and listPersonTags answer not found for a hidden contact", async () => {
    const scope = await setupTenant("hw51");
    const visible = await addAdultPerson(scope, "Vera", "Tagger");
    const hidden = await addAdultPerson(scope, "Hugo", "Tagger");
    const tagId = await inScope(
      scope,
      async (tx) => (await createTag(tx, { label: "choir" })).tagId,
    );
    await hide(scope, hidden);
    const activityBefore = await countRows(scope, "person_activity", "person_id", hidden);

    await expect(
      inScope(scope, (tx) =>
        attachTag(tx, { now: NOW, personId: hidden, tagId, actorUserId: null }),
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(await countRows(scope, "person_tag_links", "person_id", hidden)).toBe(0);
    expect(await countRows(scope, "person_activity", "person_id", hidden)).toBe(activityBefore);

    await expect(inScope(scope, (tx) => listPersonTags(tx, hidden))).resolves.toBeNull();

    await inScope(scope, (tx) =>
      attachTag(tx, { now: NOW, personId: visible, tagId, actorUserId: null }),
    );
    await expect(inScope(scope, (tx) => listPersonTags(tx, visible))).resolves.toEqual([
      { tagId, label: "choir" },
    ]);
  });

  it("detachTag answers not found for a hidden contact", async () => {
    const scope = await setupTenant("hw52");
    const visible = await addAdultPerson(scope, "Vera", "Detacher");
    const hidden = await addAdultPerson(scope, "Hugo", "Detacher");
    const tagId = await inScope(
      scope,
      async (tx) => (await createTag(tx, { label: "usher" })).tagId,
    );
    await inScope(scope, async (tx) => {
      await attachTag(tx, { now: NOW, personId: visible, tagId, actorUserId: null });
      await attachTag(tx, { now: NOW, personId: hidden, tagId, actorUserId: null });
    });
    await hide(scope, hidden);
    const activityBefore = await countRows(scope, "person_activity", "person_id", hidden);

    await expect(
      inScope(scope, (tx) =>
        detachTag(tx, { now: NOW, personId: hidden, tagId, actorUserId: null }),
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(await countRows(scope, "person_tag_links", "person_id", hidden)).toBe(1);
    expect(await countRows(scope, "person_activity", "person_id", hidden)).toBe(activityBefore);

    await expect(
      inScope(scope, (tx) =>
        detachTag(tx, { now: NOW, personId: visible, tagId, actorUserId: null }),
      ),
    ).resolves.toBeUndefined();
    expect(await countRows(scope, "person_tag_links", "person_id", visible)).toBe(0);
  });

  it("listPersonActivity answers not found for a hidden contact", async () => {
    const scope = await setupTenant("hw53");
    const visible = await addAdultPerson(scope, "Vera", "Activity");
    const hidden = await addAdultPerson(scope, "Hugo", "Activity");
    await hide(scope, hidden);

    await expect(inScope(scope, (tx) => listPersonActivity(tx, hidden))).resolves.toBeNull();

    const seen = await inScope(scope, (tx) => listPersonActivity(tx, visible));
    expect(seen).not.toBeNull();
    expect(seen?.map((a) => a.kind)).toEqual(["created"]);
  });

  it("a life event cannot be created for a hidden contact", async () => {
    const scope = await setupTenant("hw54");
    const visible = await addAdultPerson(scope, "Vera", "Eventful");
    const hidden = await addAdultPerson(scope, "Hugo", "Eventful");
    await hide(scope, hidden);

    await expect(
      inScope(scope, (tx) =>
        createLifeEvent(tx, kms, KEY_ARN, {
          personId: hidden,
          type: "baptism",
          date: "2020-06-20",
          place: "Synthetic Church",
          notes: null,
          actorUserId: null,
          now: NOW,
        }),
      ),
    ).rejects.toMatchObject({ code: "life_event_not_found" });
    expect(await countRows(scope, "life_events", "person_id", hidden)).toBe(0);

    await expect(
      inScope(scope, (tx) =>
        createLifeEvent(tx, kms, KEY_ARN, {
          personId: visible,
          type: "baptism",
          date: "2020-06-20",
          place: "Synthetic Church",
          notes: null,
          actorUserId: null,
          now: NOW,
        }),
      ),
    ).resolves.toMatchObject({ version: 1 });
    expect(await countRows(scope, "life_events", "person_id", visible)).toBe(1);
  });

  it("a hidden contact's life event cannot be updated", async () => {
    const scope = await setupTenant("hw55");
    const visible = await addAdultPerson(scope, "Vera", "Editor");
    const hidden = await addAdultPerson(scope, "Hugo", "Editor");
    const created = await inScope(scope, async (tx) => {
      const out: Record<string, string> = {};
      for (const [key, personId] of [
        ["visible", visible],
        ["hidden", hidden],
      ] as const) {
        const event = await createLifeEvent(tx, kms, KEY_ARN, {
          personId,
          type: "marriage",
          date: "2019-02-03",
          place: "Synthetic Church",
          notes: null,
          actorUserId: null,
          now: NOW,
        });
        out[key] = event.eventId;
      }
      return out;
    });
    const hiddenEvent = created["hidden"] ?? "";
    const visibleEvent = created["visible"] ?? "";
    await hide(scope, hidden);

    await expect(
      inScope(scope, (tx) =>
        updateLifeEvent(tx, kms, KEY_ARN, {
          eventId: hiddenEvent,
          version: 1,
          type: "marriage",
          date: "2019-02-04",
          place: "Changed Place",
          notes: null,
          actorUserId: null,
          now: NOW,
        }),
      ),
    ).rejects.toMatchObject({ code: "life_event_not_found" });
    const versions = await withAppTransaction(migrator, scope, async (tx) => {
      return await tx<{ version: number }[]>`
        select version from app.life_events where id = ${hiddenEvent}::uuid
      `;
    });
    expect(versions[0]?.version).toBe(1);

    await expect(
      inScope(scope, (tx) =>
        updateLifeEvent(tx, kms, KEY_ARN, {
          eventId: visibleEvent,
          version: 1,
          type: "marriage",
          date: "2019-02-04",
          place: "Changed Place",
          notes: null,
          actorUserId: null,
          now: NOW,
        }),
      ),
    ).resolves.toEqual({ version: 2 });
  });

  it("a create duplicate of a visible contact stays duplicate_email", async () => {
    const scope = await setupTenant("hw56");
    await addAdultPerson(scope, "Vera", "Holder", {
      email: "visible.holder@example.test",
      phone: "+61 433 555 101",
    });
    const hidden = await addAdultPerson(scope, "Hugo", "Holder", {
      email: "hidden.holder@example.test",
      phone: "+61 433 555 102",
    });
    const hiddenPhoneOnly = await addAdultPerson(scope, "Hana", "Holder", {
      email: "hidden.phone@example.test",
      phone: "+61 433 555 103",
    });
    await addAdultPerson(scope, "Vince", "Holder", {
      email: "visible.phone@example.test",
      phone: "+61 433 555 104",
    });
    await hide(scope, hidden);
    await hide(scope, hiddenPhoneOnly);

    async function create(email: string | null, phone: string | null): Promise<unknown> {
      return inScope(scope, (tx) =>
        createPerson(tx, kms, KEY_ARN, {
          now: NOW,
          declaredAdult: true,
          householdId: null,
          dateOfBirth: null,
          givenName: "Newcomer",
          familyName: "Holder",
          email,
          phone,
          actorUserId: null,
        }),
      );
    }

    // A visible holder keeps today's answers.
    await expect(create("visible.holder@example.test", null)).rejects.toMatchObject({
      code: "duplicate_email",
    });
    await expect(create(null, "+61 433 555 104")).rejects.toMatchObject({
      code: "duplicate_phone",
    });

    // A hidden holder gives duplicate_deleted, for the email and for the phone.
    await expect(create("hidden.holder@example.test", null)).rejects.toMatchObject({
      code: "duplicate_deleted",
    });
    await expect(create(null, "+61 433 555 103")).rejects.toMatchObject({
      code: "duplicate_deleted",
    });

    // Email first: a hidden contact holds the email and a visible one the phone.
    await expect(create("hidden.holder@example.test", "+61 433 555 104")).rejects.toMatchObject({
      code: "duplicate_deleted",
    });

    // Nothing was created by any refused call.
    const created = await withAppTransaction(migrator, scope, async (tx) => {
      return await tx<{ count: number }[]>`
        select count(*)::int as count from app.persons where given_name = 'Newcomer'
      `;
    });
    expect(created[0]?.count).toBe(0);
  });

  it("add-adult answers duplicate_deleted for a hidden holder", async () => {
    const scope = await setupTenant("hw56b");
    const householdId = await createHouseholdRow(scope, "Adult Family");
    const hidden = await addAdultPerson(scope, "Hugo", "Adder", {
      email: "adder.hidden@example.test",
      phone: null,
    });
    await hide(scope, hidden);

    await expect(
      inScope(scope, (tx) =>
        addAdult(tx, kms, KEY_ARN, {
          now: NOW,
          householdId,
          givenName: "Newcomer",
          familyName: "Adder",
          email: "adder.hidden@example.test",
          phone: null,
          dateOfBirth: null,
          actorUserId: null,
        }),
      ),
    ).rejects.toMatchObject({ code: "duplicate_deleted" });
  });

  it("an update duplicate of a visible contact stays conflict", async () => {
    const scope = await setupTenant("hw57");
    await addAdultPerson(scope, "Vera", "Visible", {
      email: "update.visible@example.test",
      phone: "+61 444 555 201",
    });
    const hidden = await addAdultPerson(scope, "Hugo", "Hidden", {
      email: "update.hidden@example.test",
      phone: "+61 444 555 202",
    });
    const subject = await addAdultPerson(scope, "Sam", "Subject", {
      email: "update.subject@example.test",
      phone: "+61 444 555 203",
    });
    await hide(scope, hidden);

    function update(changes: { email?: string; phone?: string }): Promise<unknown> {
      return inScope(scope, (tx) =>
        updatePerson(tx, kms, KEY_ARN, {
          personId: subject,
          version: 1,
          changes,
          actorUserId: null,
        }),
      );
    }

    // A visible holder keeps today's answer.
    await expect(update({ email: "update.visible@example.test" })).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(update({ phone: "+61 444 555 201" })).rejects.toMatchObject({
      code: "conflict",
    });

    // A hidden holder gives duplicate_deleted, for the email and for the phone.
    await expect(update({ email: "update.hidden@example.test" })).rejects.toMatchObject({
      code: "duplicate_deleted",
    });
    await expect(update({ phone: "+61 444 555 202" })).rejects.toMatchObject({
      code: "duplicate_deleted",
    });

    // Email first: a hidden contact holds the email and a visible one the phone.
    await expect(
      update({ email: "update.hidden@example.test", phone: "+61 444 555 201" }),
    ).rejects.toMatchObject({ code: "duplicate_deleted" });

    // Keeping its own email is not a duplicate, and nothing changed by the refused calls.
    const after = await personRow(scope, subject);
    expect(after.version).toBe(1);
    await expect(update({ email: "update.subject@example.test" })).resolves.toEqual({
      version: 2,
    });
  });
});
