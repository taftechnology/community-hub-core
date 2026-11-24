import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { applyProductMigrations, newId, withAppTransaction } from "@community-hub/db";
import {
  createPlaintextAppSql,
  createPlaintextDirectSql,
  createPlaintextPlatformSql,
} from "@community-hub/db/plaintext";
import { withRequest } from "@community-hub/kernel";

import { deleteBlockers } from "../public/index.js";

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

describe("delete-blockers", () => {
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

  async function setupTenant(slugPrefix = "blockers") {
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

  it("an expired pending invitation does not block delete", async () => {
    const scope = await setupTenant("pin31");
    const adult = await insertAdult(scope, "Expired", "Invited");

    await withAppTransaction(migrator, scope, async (tx) => {
      await tx`
        insert into app.invitations (
          id, org_id, community_id, invited_by, token_hash, person_id,
          status, expires_at, resend_count, last_sent_at, created_at
        ) values (
          ${newId()}, ${scope.orgId}, ${scope.communityId}, ${newId()}, ${FAKE_ENCRYPTED},
          ${adult}, 'pending', now() - interval '1 day', 0, now(), now()
        )
      `;
    });

    const blockers = await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, scope, async (tx) => {
        return await deleteBlockers(tx, adult);
      }),
    );

    expect(blockers).toEqual({ userLink: false, pendingInvitation: false });
  });

  it("a user link blocks delete", async () => {
    const scope = await setupTenant("pin32");
    const adult = await insertAdult(scope, "Linked", "Adult");
    const userId = newId();

    await withAppTransaction(migrator, scope, async (tx) => {
      await tx`
        insert into app.organisation_members (org_id, user_id, source, created_at)
        values (${scope.orgId}, ${userId}, 'provision', now())
      `;
      await tx`
        insert into app.user_links (id, org_id, community_id, user_id, person_id)
        values (${newId()}, ${scope.orgId}, ${scope.communityId}, ${userId}, ${adult})
      `;
    });

    const blockers = await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, scope, async (tx) => {
        return await deleteBlockers(tx, adult);
      }),
    );

    expect(blockers).toEqual({ userLink: true, pendingInvitation: false });
  });

  it("returns false for contact with no user link and no invitations", async () => {
    const scope = await setupTenant("no-blockers");
    const adult = await insertAdult(scope, "Clean", "Contact");

    const blockers = await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, scope, async (tx) => {
        return await deleteBlockers(tx, adult);
      }),
    );

    expect(blockers).toEqual({ userLink: false, pendingInvitation: false });
  });

  it("returns pendingInvitation true for contact with live pending invitation", async () => {
    const scope = await setupTenant("live-inv");
    const adult = await insertAdult(scope, "Live", "Invited");

    await withAppTransaction(migrator, scope, async (tx) => {
      await tx`
        insert into app.invitations (
          id, org_id, community_id, invited_by, token_hash, person_id,
          status, expires_at, resend_count, last_sent_at, created_at
        ) values (
          ${newId()}, ${scope.orgId}, ${scope.communityId}, ${newId()}, ${FAKE_ENCRYPTED},
          ${adult}, 'pending', now() + interval '7 days', 0, now(), now()
        )
      `;
    });

    const blockers = await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, scope, async (tx) => {
        return await deleteBlockers(tx, adult);
      }),
    );

    expect(blockers).toEqual({ userLink: false, pendingInvitation: true });
  });

  it("returns pendingInvitation false for accepted, revoked, or void invitations", async () => {
    const scope = await setupTenant("closed-inv");
    const adultAccepted = await insertAdult(scope, "Accepted", "Invited");
    const adultRevoked = await insertAdult(scope, "Revoked", "Invited");
    const adultVoid = await insertAdult(scope, "Void", "Invited");

    await withAppTransaction(migrator, scope, async (tx) => {
      await tx`
        insert into app.invitations (
          id, org_id, community_id, invited_by, token_hash, person_id,
          status, expires_at, resend_count, last_sent_at, created_at
        ) values
          (${newId()}, ${scope.orgId}, ${scope.communityId}, ${newId()}, ${FAKE_ENCRYPTED},
           ${adultAccepted}, 'accepted', now() + interval '7 days', 0, now(), now()),
          (${newId()}, ${scope.orgId}, ${scope.communityId}, ${newId()}, ${FAKE_ENCRYPTED},
           ${adultRevoked}, 'revoked', now() + interval '7 days', 0, now(), now()),
          (${newId()}, ${scope.orgId}, ${scope.communityId}, ${newId()}, ${FAKE_ENCRYPTED},
           ${adultVoid}, 'void', now() + interval '7 days', 0, now(), now())
      `;
    });

    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, scope, async (tx) => {
        expect(await deleteBlockers(tx, adultAccepted)).toEqual({
          userLink: false,
          pendingInvitation: false,
        });
        expect(await deleteBlockers(tx, adultRevoked)).toEqual({
          userLink: false,
          pendingInvitation: false,
        });
        expect(await deleteBlockers(tx, adultVoid)).toEqual({
          userLink: false,
          pendingInvitation: false,
        });
      }),
    );
  });

  it("returns both true for contact with user link and live pending invitation", async () => {
    const scope = await setupTenant("both-blockers");
    const adult = await insertAdult(scope, "Both", "Blocked");
    const userId = newId();

    await withAppTransaction(migrator, scope, async (tx) => {
      await tx`
        insert into app.organisation_members (org_id, user_id, source, created_at)
        values (${scope.orgId}, ${userId}, 'provision', now())
      `;
      await tx`
        insert into app.user_links (id, org_id, community_id, user_id, person_id)
        values (${newId()}, ${scope.orgId}, ${scope.communityId}, ${userId}, ${adult})
      `;
      await tx`
        insert into app.invitations (
          id, org_id, community_id, invited_by, token_hash, person_id,
          status, expires_at, resend_count, last_sent_at, created_at
        ) values (
          ${newId()}, ${scope.orgId}, ${scope.communityId}, ${newId()}, ${FAKE_ENCRYPTED},
          ${adult}, 'pending', now() + interval '7 days', 0, now(), now()
        )
      `;
    });

    const blockers = await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, scope, async (tx) => {
        return await deleteBlockers(tx, adult);
      }),
    );

    expect(blockers).toEqual({ userLink: true, pendingInvitation: true });
  });

  it("does not block delete when user link or invitation belongs to another community or organisation", async () => {
    const scope1 = await setupTenant("cross-1");
    const scope2 = await setupTenant("cross-2");
    const adult1 = await insertAdult(scope1, "Org1", "Adult");
    const adult2 = await insertAdult(scope2, "Org2", "Adult");
    const userId = newId();

    await withAppTransaction(migrator, scope2, async (tx) => {
      await tx`
        insert into app.organisation_members (org_id, user_id, source, created_at)
        values (${scope2.orgId}, ${userId}, 'provision', now())
      `;
      await tx`
        insert into app.user_links (id, org_id, community_id, user_id, person_id)
        values (${newId()}, ${scope2.orgId}, ${scope2.communityId}, ${userId}, ${adult2})
      `;
      await tx`
        insert into app.invitations (
          id, org_id, community_id, invited_by, token_hash, person_id,
          status, expires_at, resend_count, last_sent_at, created_at
        ) values (
          ${newId()}, ${scope2.orgId}, ${scope2.communityId}, ${newId()}, ${FAKE_ENCRYPTED},
          ${adult2}, 'pending', now() + interval '7 days', 0, now(), now()
        )
      `;
    });

    // Check scope 1 for adult1: should be completely unblocked
    const blockers = await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, scope1, async (tx) => {
        return await deleteBlockers(tx, adult1);
      }),
    );

    expect(blockers).toEqual({ userLink: false, pendingInvitation: false });
  });
});
