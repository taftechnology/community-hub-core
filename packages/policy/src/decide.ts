const CATALOGUE = [
  "access.users.view",
  "access.users.manage",
  "access.roles.view",
  "access.roles.manage",
  "people.restricted.read",
  "entitlements.view",
  "entitlements.manage",
] as const;

const BILLING = ["billing.view", "billing.manage"] as const;

const EMPTY: readonly string[] = [];

const BUNDLES: Record<string, readonly string[]> = {
  org_owner: [...CATALOGUE, ...BILLING],
  org_admin: [...CATALOGUE, ...BILLING],
  org_billing: ["access.users.view", "entitlements.view", ...BILLING],
  org_auditor: ["access.users.view", "access.roles.view", "entitlements.view", "billing.view"],
  community_admin: CATALOGUE,
  staff: ["access.users.view", "access.roles.view", "entitlements.view"],
  finance: EMPTY,
  safeguarding_officer: ["people.restricted.read", "access.users.view"],
  volunteer_coordinator: ["access.users.view"],
  content_editor: EMPTY,
  member: EMPTY,
};

export type DecideInput = {
  permission: string;
  organisationRoleKeys: readonly string[];
  communityRoleKeys: readonly string[];
  customPermissions: readonly string[];
  guardianView: boolean;
  personScoped: boolean;
};

export function catalogue(): readonly string[] {
  return CATALOGUE;
}

export function bundle(roleKey: string): readonly string[] | null {
  return BUNDLES[roleKey] ?? null;
}

function held(keys: readonly string[]): Set<string> {
  const permissions = new Set<string>();
  for (const key of keys) {
    const permissionsForRole = bundle(key);
    if (permissionsForRole === null) {
      continue;
    }
    for (const permission of permissionsForRole) {
      permissions.add(permission);
    }
  }
  return permissions;
}

export function decide(input: DecideInput): boolean {
  if (input.permission === "people.restricted.read" && input.personScoped && input.guardianView) {
    return true;
  }
  if (input.customPermissions.includes(input.permission)) {
    return true;
  }
  if (held(input.organisationRoleKeys).has(input.permission)) {
    return true;
  }
  return held(input.communityRoleKeys).has(input.permission);
}
