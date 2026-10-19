import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { post } from "./api";
import { ACCESS_TOKEN_KEY } from "./directory";

describe("admin api client post", () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.stubEnv("VITE_API_ORIGIN", "https://au.api.example.test");
    vi.stubEnv("VITE_AUTH_ORIGIN", "https://au.auth.example.test");
  });

  afterEach(() => {
    sessionStorage.clear();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("clears access token on 401 response and returns response", async () => {
    sessionStorage.setItem(ACCESS_TOKEN_KEY, "test-token-1");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    );

    const response = await post("/v1/billing/status", { communitySlug: "parish" });
    expect(response).not.toBe("unavailable");
    if (response !== "unavailable") {
      expect(response.status).toBe(401);
    }
    expect(sessionStorage.getItem(ACCESS_TOKEN_KEY)).toBeNull();
  });

  it("returns unavailable when no token is present without calling fetch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const response = await post("/v1/billing/status", { communitySlug: "parish" });
    expect(response).toBe("unavailable");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sends Bearer token and JSON headers on POST", async () => {
    sessionStorage.setItem(ACCESS_TOKEN_KEY, "test-token-2");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const response = await post("/v1/access/grants/list", { communitySlug: "parish" });
    expect(response).not.toBe("unavailable");
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0] ?? [];
    expect(url).toBe("https://au.api.example.test/v1/access/grants/list");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-token-2");
    expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
    expect(init?.body).toBe(JSON.stringify({ communitySlug: "parish" }));
  });

  it("returns unavailable when fetch rejects", async () => {
    sessionStorage.setItem(ACCESS_TOKEN_KEY, "test-token-3");
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network failure"));

    const response = await post("/v1/access/grants/list", { communitySlug: "parish" });
    expect(response).toBe("unavailable");
  });
});
