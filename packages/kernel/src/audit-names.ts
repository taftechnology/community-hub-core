export const AUDIT_NAME_RE = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;

const auditActions = new Set<string>();
const auditPurposes = new Set<string>();

function assertAuditName(name: string): void {
  if (!AUDIT_NAME_RE.test(name)) {
    throw new Error(`Invalid audit name: ${name}`);
  }
}

export function defineAuditAction(name: string): string {
  assertAuditName(name);
  auditActions.add(name);
  return name;
}

export function defineAuditPurpose(name: string): string {
  assertAuditName(name);
  auditPurposes.add(name);
  return name;
}

export function isAuditAction(name: string): boolean {
  return auditActions.has(name);
}

export function isAuditPurpose(name: string): boolean {
  return auditPurposes.has(name);
}
