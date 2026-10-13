import { EntitlementError } from "./error.js";

const ENTITLEMENT_KEY = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;
const PLAN_KEY = /^[a-z][a-z0-9_]{1,31}$/;

export function parseEntitlementKey(key: string): string {
  if (key.length > 64 || !ENTITLEMENT_KEY.test(key)) {
    throw new EntitlementError("invalid_key");
  }
  return key;
}

export function parsePlanKey(key: string): string {
  if (!PLAN_KEY.test(key)) {
    throw new EntitlementError("invalid_key");
  }
  return key;
}
