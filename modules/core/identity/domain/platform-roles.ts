/**
 * Platform role keys mirrored from modules/core/access/domain/role.ts.
 * Duplicated here because the identity module must not import the access module.
 */
export const PLATFORM_ROLE_KEYS = [
  "platform_admin",
  "platform_support",
  "platform_security",
] as const;

export type PlatformRoleKey = (typeof PLATFORM_ROLE_KEYS)[number];

const PLATFORM_ROLE_SET = new Set<string>(PLATFORM_ROLE_KEYS);

export function isPlatformRoleKey(value: string): value is PlatformRoleKey {
  return PLATFORM_ROLE_SET.has(value);
}
