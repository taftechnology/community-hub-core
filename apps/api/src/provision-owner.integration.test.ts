import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

import { findOwner } from "@community-hub/access";
import { createLocalKmsPort } from "@community-hub/crypto/testing";
import { applyProductMigrations, withAppTransaction } from "@community-hub/db";
import {
  createPlaintextAppSql,
  createPlaintextDirectSql,
  createPlaintextIdentitySql,
  createPlaintextPlatformSql,
} from "@community-hub/db/plaintext";
import {
  findUserByEmail,
  startEmailOtp,
  verifyEmailOtp,
  type OtpMail,
} from "@community-hub/identity";

import { runProvisionOwner, type ProvisionOwnerResult } from "./provision-owner.js";

/** Captures the last code the OTP flow would have mailed, like the identity suite's own fake. */
class MemoryMail implements OtpMail {
  last: { to: string; code: string } | undefined;

  send(input: { to: string; code: string }): Promise<void> {
    this.last = input;
    return Promise.resolve();
  }
}

type Runtime = {
  productOnlyUrl: string;
  passwords: { app: string; identity: string; platform: string };
};

const RUNTIME = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/test/.runtime.json",
);

const KEY_ARN = `arn:aws:kms:ap-southeast-2:123456789012:key/mrk-${"ab".repeat(16)}`;
const ARN =
  "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:ch-test-provision-owner-ab12CD";
const NOW = new Date("2026-10-13T00:00:00+11:00");

function loadRuntime(): Runtime {
  return JSON.parse(readFileSync(RUNTIME, "utf8")) as Runtime;
}

function roleUrl(runtime: Runtime, role: "app" | "identity" | "platform"): string {
  const password = encodeURIComponent(runtime.passwords[role]);
  return `postgres://${role}:${password}@127.0.0.1:5432/hub_product_only`;
}

type Conns = {
  platform: ReturnType<typeof createPlaintextPlatformSql>;
  app: ReturnType<typeof createPlaintextAppSql>;
  identity: ReturnType<typeof createPlaintextIdentitySql>;
  kms: ReturnType<typeof createLocalKmsPort>;
};

function connect(runtime: Runtime): Conns {
  return {
    platform: createPlaintextPlatformSql(roleUrl(runtime, "platform")),
    app: createPlaintextAppSql(roleUrl(runtime, "app")),
    identity: createPlaintextIdentitySql(roleUrl(runtime, "identity")),
    kms: createLocalKmsPort(),
  };
}

async function closeConns(conns: Conns): Promise<void> {
  await Promise.all([
    conns.platform.end({ timeout: 1 }),
    conns.app.end({ timeout: 1 }),
    conns.identity.end({ timeout: 1 }),
  ]);
}

/** Identity rows carry no org scope, so each test that counts them starts from empty. */
async function clearIdentity(conns: Conns): Promise<void> {
  await conns.identity`delete from identity.sessions`;
  await conns.identity`delete from identity.passkey_credentials`;
  await conns.identity`delete from identity.passkey_challenges`;
  await conns.identity`delete from identity.otp_challenges`;
  await conns.identity`delete from identity.users`;
  await conns.identity`delete from identity.identity_keys`;
}

function provision(
  conns: Conns,
  payload: { organisationSlug: string; communitySlug: string; email: string },
): Promise<ProvisionOwnerResult> {
  return runProvisionOwner({
    source: { PROVISION_SECRET_ARN: ARN },
    readSecret: async () => JSON.stringify(payload),
    platform: conns.platform,
    app: conns.app,
    identity: conns.identity,
    kms: conns.kms,
    keyArn: KEY_ARN,
    now: () => NOW,
  });
}

async function scopeBySlug(
  conns: Conns,
  organisationSlug: string,
  communitySlug: string,
): Promise<{ orgId: string; communityId: string } | null> {
  const org = await conns.platform<{ id: string }[]>`
    select id::text as id from platform.organisations where slug = ${organisationSlug}
  `;
  const community = await conns.platform<{ id: string }[]>`
    select id::text as id from platform.communities where slug = ${communitySlug}
  `;
  if (org[0] === undefined || community[0] === undefined) {
    return null;
  }
  return { orgId: org[0].id, communityId: community[0].id };
}

async function grantCounts(
  conns: Conns,
  scope: { orgId: string; communityId: string },
): Promise<{ organisation: number; community: number }> {
  return withAppTransaction(conns.app, scope, async (tx) => {
    const organisation = await tx<{ n: number; role_key: string }[]>`
      select count(*)::int as n, max(role_key) as role_key from app.organisation_role_grants
    `;
    const community = await tx<{ n: number; role_key: string }[]>`
      select count(*)::int as n, max(role_key) as role_key from app.community_role_grants
    `;
    return {
      organisation: organisation[0]?.n ?? 0,
      community: community[0]?.n ?? 0,
    };
  });
}

async function identityUserCount(conns: Conns): Promise<number> {
  const rows = await conns.identity<{ n: number }[]>`select count(*)::int as n from identity.users`;
  return rows[0]?.n ?? 0;
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

describe("runProvisionOwner against the test database", () => {
  it("creates the tenant, the identity user, and both owner grants on a fresh run", async () => {
    const conns = connect(loadRuntime());
    try {
      await clearIdentity(conns);
      const result = await provision(conns, {
        organisationSlug: "prov-fresh-org",
        communitySlug: "prov-fresh-com",
        email: "owner@example.com",
      });
      expect(result).toEqual({ exitCode: 0, stdout: "created\n", stderr: "" });

      const scope = await scopeBySlug(conns, "prov-fresh-org", "prov-fresh-com");
      expect(scope).not.toBeNull();
      expect(await identityUserCount(conns)).toBe(1);
      const grants = await grantCounts(conns, scope!);
      expect(grants).toEqual({ organisation: 1, community: 1 });
      // The grants belong to the identity user the command created.
      const owner = await withAppTransaction(conns.app, scope!, (tx) => findOwner(tx));
      const user = await findUserByEmail(conns.identity, conns.kms, KEY_ARN, {
        email: "owner@example.com",
      });
      expect(owner).not.toBeNull();
      expect(user).toEqual({ userId: owner!.userId });
    } finally {
      await closeConns(conns);
    }
  });

  it("is a no-op on a second run with the same email", async () => {
    const conns = connect(loadRuntime());
    try {
      await clearIdentity(conns);
      const payload = {
        organisationSlug: "prov-idem-org",
        communitySlug: "prov-idem-com",
        email: "owner@example.com",
      };
      expect((await provision(conns, payload)).stdout).toBe("created\n");

      const scope = await scopeBySlug(conns, "prov-idem-org", "prov-idem-com");
      const before = {
        identity: await identityUserCount(conns),
        grants: await grantCounts(conns, scope!),
      };

      const second = await provision(conns, payload);
      expect(second).toEqual({ exitCode: 0, stdout: "already_bootstrapped\n", stderr: "" });

      // Nothing was created or changed anywhere.
      const orgs = await conns.platform<{ n: number }[]>`
        select count(*)::int as n from platform.organisations where slug = 'prov-idem-org'
      `;
      const communities = await conns.platform<{ n: number }[]>`
        select count(*)::int as n from platform.communities where slug = 'prov-idem-com'
      `;
      expect(orgs[0]?.n).toBe(1);
      expect(communities[0]?.n).toBe(1);
      expect(await identityUserCount(conns)).toBe(before.identity);
      expect(await grantCounts(conns, scope!)).toEqual(before.grants);
    } finally {
      await closeConns(conns);
    }
  });

  it("refuses a second run naming a different email and creates no identity.users row", async () => {
    const conns = connect(loadRuntime());
    try {
      await clearIdentity(conns);
      expect(
        (
          await provision(conns, {
            organisationSlug: "prov-diff-org",
            communitySlug: "prov-diff-com",
            email: "first@example.com",
          })
        ).stdout,
      ).toBe("created\n");

      // REGRESSION PIN: the bug this spec revision fixed was that a second run with a
      // different email silently created a stray identity.users row while succeeding.
      // Capture the count, re-run with a different email, assert it refuses AND the
      // identity.users count is unchanged — not merely that the exit code is 1.
      const beforeUsers = await identityUserCount(conns);
      expect(beforeUsers).toBe(1);

      const second = await provision(conns, {
        organisationSlug: "prov-diff-org",
        communitySlug: "prov-diff-com",
        email: "second@example.com",
      });
      expect(second).toEqual({ exitCode: 1, stdout: "", stderr: "owner\n" });
      expect(await identityUserCount(conns)).toBe(beforeUsers);
    } finally {
      await closeConns(conns);
    }
  });

  it("refuses when the named community belongs to a different organisation and creates nothing", async () => {
    const conns = connect(loadRuntime());
    try {
      await clearIdentity(conns);
      // Establish community "prov-mismatch-com" under organisation "prov-mismatch-a".
      expect(
        (
          await provision(conns, {
            organisationSlug: "prov-mismatch-a",
            communitySlug: "prov-mismatch-com",
            email: "owner@example.com",
          })
        ).stdout,
      ).toBe("created\n");
      const usersAfterSetup = await identityUserCount(conns);

      // Now name the same community but a different organisation slug.
      const result = await provision(conns, {
        organisationSlug: "prov-mismatch-b",
        communitySlug: "prov-mismatch-com",
        email: "owner@example.com",
      });
      expect(result).toEqual({ exitCode: 1, stdout: "", stderr: "organisation\n" });

      // No organisation "prov-mismatch-b" was created, and no new identity user.
      const orgs = await conns.platform<{ n: number }[]>`
        select count(*)::int as n from platform.organisations where slug = 'prov-mismatch-b'
      `;
      expect(orgs[0]?.n).toBe(0);
      expect(await identityUserCount(conns)).toBe(usersAfterSetup);
    } finally {
      await closeConns(conns);
    }
  });

  it("resolves a differently-cased email to the same owner with exactly one identity.users row", async () => {
    const conns = connect(loadRuntime());
    try {
      await clearIdentity(conns);
      expect(
        (
          await provision(conns, {
            organisationSlug: "prov-case-org",
            communitySlug: "prov-case-com",
            email: "Ada@Example.com",
          })
        ).stdout,
      ).toBe("created\n");

      const scope = await scopeBySlug(conns, "prov-case-org", "prov-case-com");
      const owner = await withAppTransaction(conns.app, scope!, (tx) => findOwner(tx));

      // The claim is that the real OTP sign-in path — not a read helper — resolves the
      // lower-case address to the owner the mixed-case provisioning created. Drive the
      // exact functions a user's sign-in calls: start a code, then verify it, against a
      // real otp_challenges row and a real code match. The session's user is the proof.
      const mail = new MemoryMail();
      await startEmailOtp(conns.identity, conns.kms, KEY_ARN, mail, {
        email: "ada@example.com",
        now: NOW,
      });
      const session = await verifyEmailOtp(conns.identity, conns.kms, KEY_ARN, {
        email: "ada@example.com",
        code: mail.last!.code,
        now: new Date(NOW.getTime() + 60 * 1000),
      });
      expect(session).not.toBeNull();
      expect(session!.userId).toBe(owner!.userId);
      expect(await identityUserCount(conns)).toBe(1);

      // Secondary corroboration: the read helper agrees with the OTP session's user.
      const resolved = await findUserByEmail(conns.identity, conns.kms, KEY_ARN, {
        email: "ada@example.com",
      });
      expect(resolved).toEqual({ userId: owner!.userId });
    } finally {
      await closeConns(conns);
    }
  });

  it("keeps organisation A's new grants invisible to organisation B's scoped transaction", async () => {
    const conns = connect(loadRuntime());
    try {
      await clearIdentity(conns);
      expect(
        (
          await provision(conns, {
            organisationSlug: "prov-iso-a",
            communitySlug: "prov-iso-a-com",
            email: "owner-a@example.com",
          })
        ).stdout,
      ).toBe("created\n");
      // Organisation B exists but has no owner provisioned.
      expect(
        (
          await provision(conns, {
            organisationSlug: "prov-iso-b",
            communitySlug: "prov-iso-b-com",
            email: "owner-b@example.com",
          })
        ).stdout,
      ).toBe("created\n");

      const scopeA = await scopeBySlug(conns, "prov-iso-a", "prov-iso-a-com");
      const scopeB = await scopeBySlug(conns, "prov-iso-b", "prov-iso-b-com");
      const ownerA = await withAppTransaction(conns.app, scopeA!, (tx) => findOwner(tx));

      // Organisation B's scoped transaction sees its own owner, never organisation A's.
      const seenFromB = await withAppTransaction(conns.app, scopeB!, async (tx) => {
        const owner = await findOwner(tx);
        const rowsOfA = await tx<{ n: number }[]>`
          select count(*)::int as n
          from app.organisation_role_grants
          where user_id = ${ownerA!.userId}::uuid
        `;
        return { ownerUserId: owner?.userId, rowsOfA: rowsOfA[0]?.n ?? 0 };
      });
      expect(seenFromB.ownerUserId).not.toBe(ownerA!.userId);
      expect(seenFromB.rowsOfA).toBe(0);
    } finally {
      await closeConns(conns);
    }
  });
});
