import type { AppTransaction } from "@community-hub/db";
import { decide } from "@community-hub/policy";

export async function holdsPermission(
  tx: AppTransaction,
  userId: string,
  permission: string,
): Promise<boolean> {
  const organisationRows = await tx<{ role_key: string }[]>`
    select role_key
    from app.organisation_role_grants
    where user_id = ${userId}::uuid
      and org_id = current_setting('app.org_id')::uuid
  `;
  const communityRows = await tx<{ role_key: string | null; custom_role_id: string | null }[]>`
    select role_key, custom_role_id::text as custom_role_id
    from app.community_role_grants
    where user_id = ${userId}::uuid
      and org_id = current_setting('app.org_id')::uuid
      and community_id = current_setting('app.community_id')::uuid
  `;
  const customPermissions: string[] = [];
  for (const row of communityRows) {
    if (row.custom_role_id === null) {
      continue;
    }
    const permissionRows = await tx<{ permission: string }[]>`
      select custom_role_permissions.permission
      from app.custom_roles
      join app.custom_role_permissions
        on custom_role_permissions.custom_role_id = custom_roles.id
        and custom_role_permissions.org_id = custom_roles.org_id
        and custom_role_permissions.community_id = custom_roles.community_id
      where custom_roles.id = ${row.custom_role_id}::uuid
        and custom_roles.org_id = current_setting('app.org_id')::uuid
        and custom_roles.community_id = current_setting('app.community_id')::uuid
    `;
    for (const item of permissionRows) {
      customPermissions.push(item.permission);
    }
  }
  return decide({
    permission,
    organisationRoleKeys: organisationRows.map((row) => row.role_key),
    communityRoleKeys: communityRows.flatMap((row) =>
      row.role_key === null ? [] : [row.role_key],
    ),
    customPermissions,
    guardianView: false,
    personScoped: false,
  });
}
