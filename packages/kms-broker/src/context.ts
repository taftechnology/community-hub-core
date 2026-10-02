export class ContextRejected extends Error {
  constructor() {
    super("Context rejected");
    this.name = "ContextRejected";
  }
}

export type KmsContext =
  | { key_kind: "org"; org_id: string; key_version: string }
  | { key_kind: "identity"; region: string; key_version: string };

const ORG_KEYS = new Set(["key_kind", "org_id", "key_version"]);
const IDENTITY_KEYS = new Set(["key_kind", "region", "key_version"]);

function reject(): never {
  throw new ContextRejected();
}

export function checkContext(context: unknown): KmsContext {
  if (context === null || typeof context !== "object") {
    reject();
  }

  const rec = context as Record<string, unknown>;
  const hasOrgId = Object.hasOwn(rec, "org_id");
  const hasRegion = Object.hasOwn(rec, "region");
  if (hasOrgId && hasRegion) {
    reject();
  }
  if (!hasOrgId && !hasRegion) {
    reject();
  }
  if (typeof rec.key_version !== "string") {
    reject();
  }

  if (rec.key_kind === "org") {
    if (!hasOrgId || hasRegion || typeof rec.org_id !== "string") {
      reject();
    }
    for (const key of Object.keys(rec)) {
      if (!ORG_KEYS.has(key)) {
        reject();
      }
    }
    return { key_kind: "org", org_id: rec.org_id, key_version: rec.key_version };
  }

  if (rec.key_kind === "identity") {
    if (!hasRegion || hasOrgId || typeof rec.region !== "string") {
      reject();
    }
    for (const key of Object.keys(rec)) {
      if (!IDENTITY_KEYS.has(key)) {
        reject();
      }
    }
    return { key_kind: "identity", region: rec.region, key_version: rec.key_version };
  }

  reject();
}
