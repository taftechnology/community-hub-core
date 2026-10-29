import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { newId } from "@community-hub/db";
import { createPlaintextDirectSql, createPlaintextPlatformSql } from "@community-hub/db/plaintext";

export type Runtime = {
  productOnlyUrl: string;
  passwords: { app: string; identity: string; platform: string };
};

export const RUNTIME_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../../packages/db/test/.runtime.json",
);

export function loadRuntime(): Runtime {
  return JSON.parse(readFileSync(RUNTIME_PATH, "utf8")) as Runtime;
}

export function roleUrl(runtime: Runtime, role: "app" | "identity" | "platform"): string {
  const password = encodeURIComponent(runtime.passwords[role]);
  return `postgres://${role}:${password}@127.0.0.1:5432/hub_product_only`;
}

export async function createScope(
  platform: ReturnType<typeof createPlaintextPlatformSql>,
): Promise<{
  orgId: string;
  communityId: string;
}> {
  const orgId = newId();
  const communityId = newId();
  await platform.begin(async (tx) => {
    await tx`
      insert into platform.organisations (id, slug, region, kind)
      values (${orgId}, ${`scope-${orgId.slice(0, 8)}`}, 'au', 'implicit')
    `;
    await tx`
      insert into platform.communities (id, organisation_id, slug, region)
      values (${communityId}, ${orgId}, ${`scope-${communityId.slice(0, 8)}`}, 'au')
    `;
  });
  return { orgId, communityId };
}

export async function cleanScope(
  directSql: ReturnType<typeof createPlaintextDirectSql>,
  scope: { orgId: string; communityId: string },
): Promise<void> {
  await directSql`delete from app.group_members where org_id = ${scope.orgId}::uuid`.catch(
    () => {},
  );
  await directSql`delete from app.groups where org_id = ${scope.orgId}::uuid`.catch(() => {});
  await directSql`delete from app.usage_facts_daily where org_id = ${scope.orgId}::uuid`.catch(
    () => {},
  );
  await directSql`delete from app.person_activity where org_id = ${scope.orgId}::uuid`.catch(
    () => {},
  );
  await directSql`delete from app.persons where org_id = ${scope.orgId}::uuid`.catch(() => {});
  await directSql`delete from app.guardian_links where org_id = ${scope.orgId}::uuid`.catch(
    () => {},
  );
  await directSql`delete from app.household_keys where org_id = ${scope.orgId}::uuid`.catch(
    () => {},
  );
  await directSql`delete from app.households where org_id = ${scope.orgId}::uuid`.catch(() => {});
  await directSql`delete from app.community_keys where org_id = ${scope.orgId}::uuid`.catch(
    () => {},
  );
  await directSql`delete from app.organisation_keys where org_id = ${scope.orgId}::uuid`.catch(
    () => {},
  );
  await directSql`delete from app.audit_events where org_id = ${scope.orgId}::uuid`.catch(() => {});
  await directSql`delete from platform.communities where organisation_id = ${scope.orgId}::uuid`.catch(
    () => {},
  );
  await directSql`delete from platform.organisations where id = ${scope.orgId}::uuid`.catch(
    () => {},
  );
}
