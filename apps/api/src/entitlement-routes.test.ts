import { describe, expect, it } from "vitest";
import { withRequest } from "@community-hub/kernel";

import { entitlementRoutes, type EntitlementDeps } from "./entitlement-routes.js";

const API_HOSTNAME = "au.api.example.test";
const AUTH_HOSTNAME = "auth.au.example.test";
const REQUEST_ID = "66666666-6666-4666-8666-666666666666";

function deps(): EntitlementDeps {
  return {
    checkout: () => Promise.reject(new Error("checkout")),
    kms: {} as EntitlementDeps["kms"],
    keyArn: "arn:aws:kms:ap-southeast-2:123456789012:key/mrk-test",
    now: () => new Date("2026-10-12T00:00:00.000Z"),
    apiHostname: API_HOSTNAME,
    log: () => undefined,
  };
}

function request(pathName: string, hostname: string, authorization?: string): Request {
  const headers = new Headers({
    "content-type": "application/json",
    "x-community-hub-hostname": hostname,
  });
  if (authorization !== undefined) {
    headers.set("authorization", authorization);
  }
  return new Request(`http://127.0.0.1${pathName}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ communitySlug: "parish" }),
  });
}

function route(pathName: string): ReturnType<typeof entitlementRoutes>[number] {
  const found = entitlementRoutes(deps()).find((item) => item.pattern === pathName);
  if (found === undefined) {
    throw new Error(pathName);
  }
  return found;
}

describe("entitlement routes", () => {
  it("serves list and toggle on the tenant surface", () => {
    expect(
      entitlementRoutes(deps()).map((item) => ({
        method: item.method,
        pattern: item.pattern,
        surface: item.surface,
      })),
    ).toEqual([
      { method: "POST", pattern: "/v1/entitlements/list", surface: "tenant" },
      { method: "POST", pattern: "/v1/entitlements/toggle", surface: "tenant" },
    ]);
  });

  it("answers the auth hostname with 404 and a missing bearer with 401", async () => {
    const listed = route("/v1/entitlements/list");
    const hidden = await withRequest({ requestId: REQUEST_ID }, async () =>
      listed.handle(request("/v1/entitlements/list", AUTH_HOSTNAME, "Bearer token")),
    );
    expect(hidden.status).toBe(404);
    expect(await hidden.text()).toBe("");

    const open = await withRequest({ requestId: REQUEST_ID }, async () =>
      listed.handle(request("/v1/entitlements/list", API_HOSTNAME)),
    );
    expect(open.status).toBe(401);
    expect(await open.text()).toBe("");
  });
});
