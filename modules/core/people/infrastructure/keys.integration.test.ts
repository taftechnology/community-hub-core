import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

import { createLocalKmsPort, type KmsPort } from "@community-hub/crypto/testing";
import { applyProductMigrations, newId, withAppTransaction } from "@community-hub/db";
import {
  createPlaintextAppSql,
  createPlaintextDirectSql,
  createPlaintextPlatformSql,
} from "@community-hub/db/plaintext";

import { ensureCommunityKey, ensureOrganisationKey } from "../public/index.js";

type Runtime = {
  productOnlyUrl: string;
  passwords: { app: string; identity: string; platform: string };
};

const RUNTIME = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/db/test/.runtime.json",
);

const KEY_ARN = `arn:aws:kms:ap-southeast-2:123456789012:key/mrk-${"ab".repeat(16)}`;

function loadRuntime(): Runtime {
  return JSON.parse(readFileSync(RUNTIME, "utf8")) as Runtime;
}

function roleUrl(runtime: Runtime, role: "app" | "platform"): string {
  const password = encodeURIComponent(runtime.passwords[role]);
  return `postgres://${role}:${password}@127.0.0.1:5432/hub_product_only`;
}

function recordingKms(port: KmsPort): { kms: KmsPort; contexts: string[][] } {
  const contexts: string[][] = [];
  return {
    contexts,
    kms: {
      async generateDataKey(keyId, context) {
        contexts.push(Object.keys(context));
        return port.generateDataKey(keyId, context);
      },
      async decrypt(keyId, blob, context) {
        contexts.push(Object.keys(context));
        return port.decrypt(keyId, blob, context);
      },
    },
  };
}

function gatingKms(port: KmsPort): KmsPort {
  let inside = 0;
  let release: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    async generateDataKey(keyId, context) {
      inside += 1;
      if (inside >= 2) {
        release();
      }
      await Promise.race([
        opened,
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error("generateDataKey wait timed out")), 2000);
        }),
      ]);
      return port.generateDataKey(keyId, context);
    },
    decrypt: (keyId, blob, context) => port.decrypt(keyId, blob, context),
  };
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

describe("organisation and community keys", () => {
  it("stores one organisation key and one community key under the organisation context", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const direct = createPlaintextDirectSql(runtime.productOnlyUrl);
    const organisationId = newId();
    const communityId = newId();
    const { kms, contexts } = recordingKms(createLocalKmsPort());
    try {
      await platform.begin(async (tx) => {
        await tx`
          insert into platform.organisations (id, slug, region, kind)
          values (${organisationId}, 'example-parish', 'au', 'implicit')
        `;
        await tx`
          insert into platform.communities (id, organisation_id, slug, region)
          values (${communityId}, ${organisationId}, 'example-parish', 'au')
        `;
      });
      const scope = { orgId: organisationId, communityId };
      const first = await withAppTransaction(app, scope, (tx) =>
        ensureOrganisationKey(tx, kms, KEY_ARN),
      );
      const second = await withAppTransaction(app, scope, (tx) =>
        ensureOrganisationKey(tx, kms, KEY_ARN),
      );
      expect(first).toEqual({ keyId: second.keyId });
      expect(Object.keys(first)).toEqual(["keyId"]);

      const organisationKeys = await direct<{ key_version: string }[]>`
        select key_version
        from app.organisation_keys
        where org_id = ${organisationId}
      `;
      expect(organisationKeys).toEqual([{ key_version: "1" }]);
      expect(contexts.length).toBeGreaterThan(0);
      for (const keys of contexts) {
        expect([...keys].sort()).toEqual(["key_kind", "key_version", "org_id"]);
      }

      const community = await withAppTransaction(app, scope, (tx) =>
        ensureCommunityKey(tx, kms, KEY_ARN),
      );
      const communityKeys = await direct<{ parent_key_id: string }[]>`
        select parent_key_id::text as parent_key_id
        from app.community_keys
        where community_id = ${communityId}
      `;
      expect(communityKeys).toEqual([{ parent_key_id: first.keyId }]);
      expect(community.keyId).not.toBe(first.keyId);
      for (const keys of contexts) {
        expect([...keys].sort()).toEqual(["key_kind", "key_version", "org_id"]);
      }
    } finally {
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
      await direct.end({ timeout: 1 });
    }
  });

  it("keeps the winning organisation key when two ensures overlap", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const direct = createPlaintextDirectSql(runtime.productOnlyUrl);
    const organisationId = newId();
    const communityId = newId();
    const kms = gatingKms(createLocalKmsPort());
    try {
      await platform.begin(async (tx) => {
        await tx`
          insert into platform.organisations (id, slug, region, kind)
          values (${organisationId}, 'second-parish', 'au', 'implicit')
        `;
        await tx`
          insert into platform.communities (id, organisation_id, slug, region)
          values (${communityId}, ${organisationId}, 'second-parish', 'au')
        `;
      });
      const scope = { orgId: organisationId, communityId };
      const [first, second] = await Promise.all([
        withAppTransaction(app, scope, (tx) => ensureOrganisationKey(tx, kms, KEY_ARN)),
        withAppTransaction(app, scope, (tx) => ensureOrganisationKey(tx, kms, KEY_ARN)),
      ]);
      expect(first.keyId).toBe(second.keyId);
      const rows = await direct<{ n: number }[]>`
        select count(*)::int as n
        from app.organisation_keys
        where org_id = ${organisationId}
      `;
      expect(rows).toEqual([{ n: 1 }]);
    } finally {
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
      await direct.end({ timeout: 1 });
    }
  });
});
