export const BUILT_IN_ROLE_LABELS: Record<string, string> = {
  org_owner: "Organisation Owner",
  org_admin: "Organisation Admin",
  org_billing: "Organisation Billing",
  org_auditor: "Organisation Auditor",
  community_admin: "Community Admin",
  staff: "Staff",
  finance: "Finance",
  safeguarding_officer: "Safeguarding Officer",
  volunteer_coordinator: "Volunteer Coordinator",
  content_editor: "Content Editor",
  member: "Member",
};

export const BUILT_IN_ROLE_KEYS = Object.keys(BUILT_IN_ROLE_LABELS);

export function roleLabel(key: string): string {
  return BUILT_IN_ROLE_LABELS[key] ?? key;
}

// What a role or a permission lets a person do, in a sentence, where the key alone does not say.
// A child's details are held back from every permission, including people.restricted.read: only a
// Community Admin may ask to see them, one field at a time, after a second-factor check (ADR 0017).
export const ROLE_DESCRIPTIONS: Record<string, string> = {
  community_admin: "Can view children's details (a second-factor check for each field)",
};

export const PERMISSION_DESCRIPTIONS: Record<string, string> = {
  "people.restricted.read": "Restricted details of adults",
};

export function roleDescription(key: string): string | undefined {
  return ROLE_DESCRIPTIONS[key];
}

export function permissionDescription(key: string): string | undefined {
  return PERMISSION_DESCRIPTIONS[key];
}
