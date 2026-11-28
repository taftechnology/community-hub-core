import type { webcrypto } from "node:crypto";

import {
  decrypt,
  deriveKeys,
  encrypt,
  generateAndWrap,
  unwrapKey,
  unwrapKmsRoot,
  type Ciphertext,
  type KmsPort,
} from "@community-hub/crypto";
import { appendAuditEvent, newId, type AppTransaction } from "@community-hub/db";
import { recordSuccess } from "@community-hub/usage";

import { type ChildView, isChildView } from "../domain/child-view.js";
import { PeopleError } from "../domain/error.js";
import { normaliseName } from "../domain/person.js";
import { childLabels } from "./child-labels.js";
import type { HouseholdStatus } from "./household-status.js";
import { ensureCommunityKey } from "./keys.js";
import { assertLabelFreeOfChildNames } from "./label-check.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HOUSEHOLD_CREATED = "people.household.created";
const HOUSEHOLD_READ = "people.household.read";
const HOUSEHOLD_UPDATED = "people.household.updated";
const LABEL = "people.household_label";

function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replaceAll("-", "");
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function asCiphertext(bytes: Uint8Array): Ciphertext {
  return bytes as never;
}

function actor(actorUserId: string | null): {
  actorKind: "system" | "user";
  actorId: string | null;
} {
  if (actorUserId === null) {
    return { actorKind: "system", actorId: null };
  }
  return { actorKind: "user", actorId: actorUserId };
}

async function setting(
  tx: AppTransaction,
  name: "app.org_id" | "app.community_id",
): Promise<string> {
  const rows = await tx<{ value: string }[]>`
    select current_setting(${name}) as value
  `;
  const value = rows[0]?.value;
  if (value === undefined || value.length === 0) {
    throw new Error("tenant setting is missing");
  }
  return value;
}

async function communityWrapKey(
  tx: AppTransaction,
  kms: KmsPort,
  keyArn: string,
  communityKeyId: string,
): Promise<webcrypto.CryptoKey> {
  const communities = await tx<{ id: string; wrapped: Uint8Array; parent_key_id: string }[]>`
    select id::text as id, wrapped, parent_key_id::text as parent_key_id
    from app.community_keys
    where id = ${communityKeyId}::uuid
  `;
  const community = communities[0];
  if (community === undefined) {
    throw new Error("community key is missing");
  }
  const organisations = await tx<{ wrapped: Uint8Array }[]>`
    select wrapped from app.organisation_keys where id = ${community.parent_key_id}::uuid
  `;
  const organisation = organisations[0];
  if (organisation === undefined) {
    throw new Error("organisation key is missing");
  }
  const orgId = await setting(tx, "app.org_id");
  const orgHkdfKey = await unwrapKmsRoot(kms, keyArn, organisation.wrapped, {
    key_kind: "org",
    org_id: orgId,
    key_version: "1",
  });
  const { wrap: orgWrap } = await deriveKeys(orgHkdfKey);
  const communityId = await setting(tx, "app.community_id");
  const communityHkdfKey = await unwrapKey(community.wrapped, orgWrap, {
    tag: "chub/wrap/v1",
    childKind: "community",
    childId: uuidToBytes(communityId),
    childKeyId: uuidToBytes(community.id),
    parentKeyId: uuidToBytes(community.parent_key_id),
  });
  const { wrap } = await deriveKeys(communityHkdfKey);
  return wrap;
}

export async function householdFieldKeys(
  tx: AppTransaction,
  kms: KmsPort,
  keyArn: string,
  householdId: string,
): Promise<{ enc: webcrypto.CryptoKey; keyId: string }> {
  const keys = await tx<{ id: string; wrapped: Uint8Array; parent_key_id: string }[]>`
    select id::text as id, wrapped, parent_key_id::text as parent_key_id
    from app.household_keys
    where household_id = ${householdId}::uuid
  `;
  const householdKey = keys[0];
  if (householdKey === undefined) {
    throw new Error("household key is missing");
  }
  const wrap = await communityWrapKey(tx, kms, keyArn, householdKey.parent_key_id);
  const childHkdfKey = await unwrapKey(householdKey.wrapped, wrap, {
    tag: "chub/wrap/v1",
    childKind: "household",
    childId: uuidToBytes(householdId),
    childKeyId: uuidToBytes(householdKey.id),
    parentKeyId: uuidToBytes(householdKey.parent_key_id),
  });
  const { enc } = await deriveKeys(childHkdfKey);
  return { enc, keyId: householdKey.id };
}

async function householdEncKey(
  tx: AppTransaction,
  kms: KmsPort,
  keyArn: string,
  householdId: string,
): Promise<webcrypto.CryptoKey> {
  const { enc } = await householdFieldKeys(tx, kms, keyArn, householdId);
  return enc;
}

export async function openField(
  bytes: Uint8Array | null,
  enc: webcrypto.CryptoKey,
  rowId: string,
  communityId: string,
  label: string,
): Promise<string | null> {
  if (bytes === null) {
    return null;
  }
  const plain = await decrypt(asCiphertext(bytes), async () => enc, {
    tag: "chub/field/v1",
    label,
    rowId: uuidToBytes(rowId),
    communityId: uuidToBytes(communityId),
  });
  return new TextDecoder().decode(plain);
}

export async function openHouseholdLabel(
  tx: AppTransaction,
  kms: KmsPort,
  keyArn: string,
  householdId: string,
): Promise<{ householdId: string; label: string | null } | null> {
  const rows = await tx<{ id: string; label: Uint8Array | null }[]>`
    select id::text as id, label
    from app.households
    where id = ${householdId}::uuid
      and org_id = current_setting('app.org_id')::uuid
      and community_id = current_setting('app.community_id')::uuid
      and deleted_at is null
  `;
  const row = rows[0];
  if (row === undefined) {
    return null;
  }
  if (row.label === null) {
    return { householdId: row.id, label: null };
  }
  const enc = await householdEncKey(tx, kms, keyArn, row.id);
  const communityId = await setting(tx, "app.community_id");
  const plain = await decrypt(asCiphertext(row.label), async () => enc, {
    tag: "chub/field/v1",
    label: LABEL,
    rowId: uuidToBytes(row.id),
    communityId: uuidToBytes(communityId),
  });
  return { householdId: row.id, label: new TextDecoder().decode(plain) };
}

export async function createHousehold(
  tx: AppTransaction,
  kms: KmsPort,
  keyArn: string,
  input: { now: Date; label: string | null; actorUserId: string | null },
): Promise<{ householdId: string; version: number }> {
  const label = input.label === null ? null : normaliseName(input.label);
  const { keyId: communityKeyId } = await ensureCommunityKey(tx, kms, keyArn);
  const communityId = await setting(tx, "app.community_id");
  const wrap = await communityWrapKey(tx, kms, keyArn, communityKeyId);
  const householdId = newId();
  const householdKeyId = newId();
  const wrapped = await generateAndWrap(wrap, {
    tag: "chub/wrap/v1",
    childKind: "household",
    childId: uuidToBytes(householdId),
    childKeyId: uuidToBytes(householdKeyId),
    parentKeyId: uuidToBytes(communityKeyId),
  });
  const { enc } = await deriveKeys(wrapped.childHkdfKey);
  let labelBytes: Uint8Array | null = null;
  if (label !== null) {
    const ciphertext = await encrypt(
      enc,
      new TextEncoder().encode(label),
      uuidToBytes(householdKeyId),
      {
        tag: "chub/field/v1",
        label: LABEL,
        rowId: uuidToBytes(householdId),
        communityId: uuidToBytes(communityId),
      },
    );
    // A tagged template cannot take the branded value. The insert stores the bytes.
    labelBytes = ciphertext;
  }
  await tx`
    insert into app.households (id, org_id, community_id, label)
    values (
      ${householdId}::uuid,
      current_setting('app.org_id')::uuid,
      current_setting('app.community_id')::uuid,
      ${labelBytes}
    )
  `;
  await tx`
    insert into app.household_keys (
      id, org_id, community_id, household_id, wrapped, key_version, parent_key_id
    ) values (
      ${householdKeyId}::uuid,
      current_setting('app.org_id')::uuid,
      current_setting('app.community_id')::uuid,
      ${householdId}::uuid,
      ${wrapped.blob},
      '1',
      ${communityKeyId}::uuid
    )
  `;
  const recorded = actor(input.actorUserId);
  await appendAuditEvent(tx, {
    actorKind: recorded.actorKind,
    actorId: recorded.actorId,
    action: HOUSEHOLD_CREATED,
    purpose: HOUSEHOLD_CREATED,
    targetIds: [householdId],
  });
  await recordSuccess(tx, "people.households", input.now);
  return { householdId, version: 1 };
}

// A child as a household read shows one: an id and the display label "Child n" (see childLabels),
// and nothing else. A child's fields are never returned from here (ADR 0017).
export type HouseholdChildRef = {
  personId: string;
  label: string;
};

// How many children a family has, for everyone who may see the family. Under the "admin" view the
// children are listed too, as ids and labels; under "presence" there is no child row and no child id.
export type HouseholdChildren = {
  childCount: number;
  children?: HouseholdChildRef[];
};

// The children of one household, as the view allows. It reads clear columns only (is_minor,
// household_id, deleted_at, created_at, id), so nothing is decrypted and no key is opened
// (AGENTS.md §1 rule 3). A hidden child is not counted and takes no number.
async function readChildren(
  tx: AppTransaction,
  householdId: string,
  childView: ChildView,
): Promise<HouseholdChildren> {
  if (childView === "admin") {
    const labelled = await childLabels(tx, [householdId]);
    const children = labelled.map((child) => ({ personId: child.personId, label: child.label }));
    return { childCount: children.length, children };
  }
  const rows = await tx<{ count: number }[]>`
    select count(*)::int as count
    from app.persons
    where household_id = ${householdId}::uuid
      and org_id = current_setting('app.org_id')::uuid
      and community_id = current_setting('app.community_id')::uuid
      and is_minor = true
      and deleted_at is null
  `;
  return { childCount: rows[0]?.count ?? 0 };
}

export type ReadHouseholdInput = {
  householdId: string;
  childView: ChildView;
  actorUserId: string | null;
};

export type ReadHouseholdResult = {
  householdId: string;
  label: string | null;
  minors: HouseholdChildren;
};

export async function readHousehold(
  tx: AppTransaction,
  kms: KmsPort,
  keyArn: string,
  input: ReadHouseholdInput,
): Promise<ReadHouseholdResult | null> {
  if (!isChildView(input.childView)) {
    throw new PeopleError("invalid_input");
  }
  const opened = await openHouseholdLabel(tx, kms, keyArn, input.householdId);
  if (opened === null) {
    return null;
  }
  const minors = await readChildren(tx, opened.householdId, input.childView);
  const recorded = actor(input.actorUserId);
  await appendAuditEvent(tx, {
    actorKind: recorded.actorKind,
    actorId: recorded.actorId,
    action: HOUSEHOLD_READ,
    purpose: HOUSEHOLD_READ,
    targetIds: [opened.householdId],
  });
  return { householdId: opened.householdId, label: opened.label, minors };
}

export type RenameHouseholdInput = {
  householdId: string;
  version: number;
  label: string | null;
  actorUserId: string | null;
};

export async function renameHousehold(
  tx: AppTransaction,
  kms: KmsPort,
  keyArn: string,
  input: RenameHouseholdInput,
): Promise<{ version: number }> {
  if (typeof input.householdId !== "string" || !UUID_RE.test(input.householdId)) {
    throw new PeopleError("invalid_input");
  }
  if (typeof input.version !== "number" || !Number.isInteger(input.version) || input.version < 1) {
    throw new PeopleError("invalid_input");
  }

  const existingRows = await tx<{ id: string; version: number }[]>`
    select id::text as id, version
    from app.households
    where id = ${input.householdId}::uuid
      and org_id = current_setting('app.org_id')::uuid
      and community_id = current_setting('app.community_id')::uuid
      and deleted_at is null
  `;
  const existing = existingRows[0];
  if (existing === undefined) {
    throw new PeopleError("not_found");
  }
  if (existing.version !== input.version) {
    throw new PeopleError("conflict");
  }

  const label = input.label === null ? null : normaliseName(input.label);
  let labelBytes: Uint8Array | null = null;
  if (label !== null) {
    // The new label may not hold the given name of a child of this family (spec D5, O3). A child
    // being added holds a share lock on the family (createPerson), so the family is locked first:
    // this waits for that child to be committed, and the check sees them. The version is not
    // tested here; the update below still refuses a stale one.
    await tx`
      select id
      from app.households
      where id = ${input.householdId}::uuid
        and org_id = current_setting('app.org_id')::uuid
        and community_id = current_setting('app.community_id')::uuid
      for no key update
    `;
    await assertLabelFreeOfChildNames(tx, kms, keyArn, { householdId: input.householdId, label });
    const { enc, keyId } = await householdFieldKeys(tx, kms, keyArn, input.householdId);
    const communityId = await setting(tx, "app.community_id");
    const ciphertext = await encrypt(enc, new TextEncoder().encode(label), uuidToBytes(keyId), {
      tag: "chub/field/v1",
      label: LABEL,
      rowId: uuidToBytes(input.householdId),
      communityId: uuidToBytes(communityId),
    });
    labelBytes = ciphertext;
  }

  const updated = await tx<{ version: number }[]>`
    update app.households
    set
      version = version + 1,
      ${tx("label")} = ${labelBytes}
    where id = ${input.householdId}::uuid
      and org_id = current_setting('app.org_id')::uuid
      and community_id = current_setting('app.community_id')::uuid
      and deleted_at is null
      and version = ${input.version}
    returning version
  `;
  if (updated[0] === undefined) {
    throw new PeopleError("conflict");
  }

  const recorded = actor(input.actorUserId);
  await appendAuditEvent(tx, {
    actorKind: recorded.actorKind,
    actorId: recorded.actorId,
    action: HOUSEHOLD_UPDATED,
    purpose: HOUSEHOLD_UPDATED,
    targetIds: [input.householdId],
  });

  return { version: updated[0].version };
}

export type HouseholdAdultMember = {
  id: string;
  personId: string;
  givenName: string;
  familyName: string;
  version: number;
};

export type HouseholdGuardianLink = {
  linkId: string;
  id: string;
  guardianId: string;
  childId: string;
  // Only under the "admin" view, for a link to a child: the child as an id and a label.
  child?: HouseholdChildRef;
  rights: {
    consent: boolean;
    pickup: boolean;
    view: boolean;
    manage: boolean;
  };
};

export type ReadHouseholdDetailInput = {
  householdId: string;
  // The adult-level family label, as before.
  includeRestricted: boolean;
  // How much of a child to show; required, with no default (ADR 0017).
  childView: ChildView;
  actorUserId: string | null;
};

export type ReadHouseholdDetailResult = {
  householdId: string;
  version: number;
  status: HouseholdStatus;
  label: string | null;
  adults: HouseholdAdultMember[];
  minors: HouseholdChildren;
  guardians: HouseholdGuardianLink[];
};

export async function readHouseholdDetail(
  tx: AppTransaction,
  kms: KmsPort,
  keyArn: string,
  input: ReadHouseholdDetailInput,
): Promise<ReadHouseholdDetailResult | null> {
  if (!isChildView(input.childView)) {
    throw new PeopleError("invalid_input");
  }
  if (typeof input.householdId !== "string" || !UUID_RE.test(input.householdId)) {
    throw new PeopleError("invalid_input");
  }

  const rows = await tx<
    {
      id: string;
      version: number;
      status: HouseholdStatus;
      label: Uint8Array | null;
    }[]
  >`
    select id::text as id, version, status, label
    from app.households
    where id = ${input.householdId}::uuid
      and org_id = current_setting('app.org_id')::uuid
      and community_id = current_setting('app.community_id')::uuid
      and deleted_at is null
  `;
  const household = rows[0];
  if (household === undefined) {
    return null;
  }

  const recorded = actor(input.actorUserId);
  await appendAuditEvent(tx, {
    actorKind: recorded.actorKind,
    actorId: recorded.actorId,
    action: HOUSEHOLD_READ,
    purpose: HOUSEHOLD_READ,
    targetIds: [household.id],
  });

  let label: string | null = null;
  let enc: webcrypto.CryptoKey | null = null;
  const communityId = await setting(tx, "app.community_id");

  if (input.includeRestricted) {
    if (household.label !== null) {
      const keys = await householdFieldKeys(tx, kms, keyArn, household.id);
      enc = keys.enc;
      label = await openField(household.label, enc, household.id, communityId, LABEL);
    }
  }

  const adultRows = await tx<
    {
      id: string;
      given_name: string | null;
      family_name: string | null;
      version: number;
    }[]
  >`
    select id::text as id, given_name, family_name, version
    from app.persons
    where household_id = ${input.householdId}::uuid
      and org_id = current_setting('app.org_id')::uuid
      and community_id = current_setting('app.community_id')::uuid
      and is_minor = false
      and deleted_at is null
    order by id asc
  `;
  const adults: HouseholdAdultMember[] = adultRows.map((r) => ({
    id: r.id,
    personId: r.id,
    givenName: r.given_name ?? "",
    familyName: r.family_name ?? "",
    version: r.version,
  }));

  // The children: a count for everyone, and ids and labels for a Community Admin. Nothing of a
  // child is decrypted, and no key is opened for one (ADR 0017).
  const minors = await readChildren(tx, household.id, input.childView);

  // Guardian links. The child is joined here, in the same scope, so a link to a person who is
  // hidden or in another community is not listed.
  const linkRows = await tx<
    {
      id: string;
      guardian_person_id: string;
      child_person_id: string;
      consent: boolean;
      pickup: boolean;
      view: boolean;
      manage: boolean;
      child_is_minor: boolean;
      child_household_id: string | null;
    }[]
  >`
    select
      gl.id::text as id,
      gl.guardian_person_id::text as guardian_person_id,
      gl.child_person_id::text as child_person_id,
      gl.consent,
      gl.pickup,
      gl.view,
      gl.manage,
      cp.is_minor as child_is_minor,
      cp.household_id::text as child_household_id
    from app.guardian_links gl
    inner join app.persons cp
      on cp.id = gl.child_person_id
      and cp.org_id = current_setting('app.org_id')::uuid
      and cp.community_id = current_setting('app.community_id')::uuid
      and cp.deleted_at is null
    where gl.household_id = ${input.householdId}::uuid
      and gl.org_id = current_setting('app.org_id')::uuid
      and gl.community_id = current_setting('app.community_id')::uuid
      and exists (
        select 1 from app.persons gp
        where gp.id = gl.guardian_person_id
          and gp.org_id = current_setting('app.org_id')::uuid
          and gp.community_id = current_setting('app.community_id')::uuid
          and gp.deleted_at is null
      )
    order by gl.id asc
  `;

  // Under "admin" a link to a child names the child by the label it has in its own household.
  const labelOf = new Map<string, string>();
  if (input.childView === "admin") {
    const households = linkRows
      .filter((row) => row.child_is_minor && row.child_household_id !== null)
      .map((row) => row.child_household_id as string);
    for (const child of await childLabels(tx, households)) {
      labelOf.set(child.personId, child.label);
    }
  }

  const guardians: HouseholdGuardianLink[] = [];
  for (const row of linkRows) {
    const link: HouseholdGuardianLink = {
      linkId: row.id,
      id: row.id,
      guardianId: row.guardian_person_id,
      childId: row.child_person_id,
      rights: {
        consent: row.consent,
        pickup: row.pickup,
        view: row.view,
        manage: row.manage,
      },
    };
    if (!row.child_is_minor) {
      // Only a person positively known to be an adult is listed without a view.
      guardians.push(link);
      continue;
    }
    if (input.childView !== "admin") {
      // A link to a child is omitted: it would carry the child's id.
      continue;
    }
    const label = labelOf.get(row.child_person_id);
    if (label === undefined) {
      // The child was hidden between the two reads: leave the link out.
      continue;
    }
    guardians.push({ ...link, child: { personId: row.child_person_id, label } });
  }

  return {
    householdId: household.id,
    version: household.version,
    status: household.status,
    label,
    adults,
    minors,
    guardians,
  };
}
