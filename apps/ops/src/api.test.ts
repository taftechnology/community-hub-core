import { describe, expect, it, vi } from "vitest";

import { createApi, isGenericFailure } from "./api.js";

describe("api", () => {
  it("every POST is relative JSON with no Authorization (Pin 4)", async () => {
    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;

    const fakeFetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const api = createApi(fakeFetch as typeof fetch);

    // Default body is "{}"
    const res1 = await api.post("/v1/ops/session/refresh");
    expect(capturedUrl).toBe("/v1/ops/session/refresh");
    expect(capturedInit?.method).toBe("POST");
    expect(capturedInit?.body).toBe("{}");

    const headers = new Headers(capturedInit?.headers);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("authorization")).toBeNull();
    expect(res1).toEqual({ kind: "response", status: 200, body: { ok: true } });

    // Explicit body stringified
    await api.post("/v1/ops/test", { email: "operator@example.test" });
    expect(capturedInit?.body).toBe('{"email":"operator@example.test"}');

    // keepalive option passed through
    await api.post("/v1/ops/test", {}, { keepalive: true });
    expect(capturedInit?.keepalive).toBe(true);
  });

  it("throws synchronously for absolute or non-ops paths", () => {
    const fakeFetch = vi.fn();
    const api = createApi(fakeFetch as typeof fetch);

    expect(() => api.get("https://ops.example.test/v1/ops/me")).toThrow();
    expect(() => api.get("/v1/admin/me")).toThrow();
    expect(() => api.get("/api/me")).toThrow();

    expect(() => api.post("https://ops.example.test/v1/ops/session/refresh")).toThrow();
    expect(() => api.post("/v1/admin/session/refresh")).toThrow();
    expect(() => api.post("/api/session/refresh")).toThrow();

    expect(fakeFetch).not.toHaveBeenCalled();
  });

  it("handles network failure and non-JSON / empty responses", async () => {
    const rejectingFetch = vi.fn().mockRejectedValue(new Error("Connection refused"));
    const api = createApi(rejectingFetch as typeof fetch);

    const netResult = await api.get("/v1/ops/me");
    expect(netResult).toEqual({ kind: "network" });

    const emptyFetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const emptyApi = createApi(emptyFetch as typeof fetch);
    const emptyResult = await emptyApi.get("/v1/ops/directory");
    expect(emptyResult).toEqual({ kind: "response", status: 204, body: undefined });

    const htmlFetch = vi
      .fn()
      .mockResolvedValue(new Response("<html>Bad Gateway</html>", { status: 502 }));
    const htmlApi = createApi(htmlFetch as typeof fetch);
    const htmlResult = await htmlApi.get("/v1/ops/me");
    expect(htmlResult).toEqual({ kind: "response", status: 502, body: undefined });
  });

  it("identifies generic failures with isGenericFailure", () => {
    expect(isGenericFailure({ kind: "network" })).toBe(true);
    expect(isGenericFailure({ kind: "response", status: 403, body: undefined })).toBe(true);
    expect(isGenericFailure({ kind: "response", status: 429, body: undefined })).toBe(true);
    expect(isGenericFailure({ kind: "response", status: 500, body: undefined })).toBe(true);
    expect(isGenericFailure({ kind: "response", status: 502, body: undefined })).toBe(true);

    expect(isGenericFailure({ kind: "response", status: 200, body: {} })).toBe(false);
    expect(isGenericFailure({ kind: "response", status: 204, body: undefined })).toBe(false);
    expect(isGenericFailure({ kind: "response", status: 400, body: {} })).toBe(false);
    expect(isGenericFailure({ kind: "response", status: 401, body: {} })).toBe(false);
  });
});
