import { AccessError } from "./error.js";

export const ORGANISATION_ROLE_KEYS = [
  "org_owner",
  "org_admin",
  "org_billing",
  "org_auditor",
] as const;

export const COMMUNITY_ROLE_KEYS = [
  "community_admin",
  "staff",
  "finance",
  "safeguarding_officer",
  "volunteer_coordinator",
  "content_editor",
  "member",
] as const;

export const PLATFORM_ROLE_KEYS = [
  "platform_admin",
  "platform_support",
  "platform_security",
] as const;

export const CATALOGUE_PERMISSIONS = [
  "access.users.view",
  "access.users.manage",
  "access.roles.view",
  "access.roles.manage",
  "people.restricted.read",
] as const;

const KEY = /^[a-z][a-z0-9_]{1,31}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const RESERVED = new Set<string>([
  ...ORGANISATION_ROLE_KEYS,
  ...COMMUNITY_ROLE_KEYS,
  ...PLATFORM_ROLE_KEYS,
]);

const CATALOGUE = new Set<string>(CATALOGUE_PERMISSIONS);

export function parseUuid(value: string): string {
  if (!UUID.test(value)) {
    throw new AccessError("invalid_id");
  }
  return value;
}

export function parseCustomRoleKey(key: string): string {
  if (!KEY.test(key) || RESERVED.has(key)) {
    throw new AccessError("invalid_role");
  }
  return key;
}

export function parsePermissionList(permissions: readonly string[]): string[] {
  if (permissions.length === 0) {
    throw new AccessError("invalid_permission");
  }
  const seen = new Set<string>();
  for (const permission of permissions) {
    if (!CATALOGUE.has(permission) || seen.has(permission)) {
      throw new AccessError("invalid_permission");
    }
    seen.add(permission);
  }
  return [...permissions];
}

export function assertCustomRoleCapacity(count: number): void {
  if (count >= 20) {
    throw new AccessError("limit_reached");
  }
}
