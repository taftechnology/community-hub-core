import { UsageError } from "./error.js";

const FEATURE_KEY = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;

export function parseFeatureKey(key: string): string {
  if (key.length === 0 || key.length > 64 || !FEATURE_KEY.test(key)) {
    throw new UsageError("invalid_feature_key");
  }
  return key;
}
