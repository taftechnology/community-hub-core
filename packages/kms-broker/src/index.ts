import { readFileSync } from "node:fs";

export { checkContext, ContextRejected } from "./context.js";
export type { KmsContext } from "./context.js";

export type Contract = {
  version: number;
  listen: string;
  logicalKeyId: string;
  routes: {
    generateDataKey: { method: string; path: string };
    decrypt: { method: string; path: string };
  };
  contextKeys: {
    org: string[];
    identity: string[];
  };
  error: {
    statusRejected: number;
    statusFailed: number;
    body: { error: string };
  };
  limits: { maxBodyBytes: number };
  responseHeaders: { "cache-control": string };
  logFields: string[];
};

export function readContract(): Contract {
  return JSON.parse(readFileSync(new URL("../contract/kms-port-v1.json", import.meta.url), "utf8"));
}
