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
