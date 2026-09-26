import { describe, expect, it, vi } from "vitest";

import { getRequestContext } from "./request";
import { createRequestHandler, healthRequest } from "./request-handler";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const INBOUND_UUID = "11111111-1111-4111-8111-111111111111";
const REJECTED_UUID = "22222222-2222-4222-8222-222222222222";

function fieldValues(fields: Record<string, unknown>): string[] {
  return Object.values(fields).map((value) => String(value));
}

describe("createRequestHandler", () => {
  it("logs one structured line without leaking request parts", async () => {
    const info = vi.fn();
    const run = createRequestHandler({ info }, (request) => healthRequest(request));

    const getResponse = await run(
      new Request("https://example.test/health?query-leak-token", {
        method: "GET",
        headers: { "header-leak-token": "header-leak-token" },
      }),
    );
    expect(getResponse.status).toBe(200);
    expect(info).toHaveBeenCalledTimes(1);

    const getFields = info.mock.calls[0]![0];
    expect(Object.keys(getFields).sort()).toEqual([
      "duration",
      "method",
      "path",
      "requestId",
      "status",
    ]);
    for (const value of fieldValues(getFields)) {
      expect(value).not.toContain("query-leak-token");
      expect(value).not.toContain("header-leak-token");
      expect(value).not.toContain("body-leak-token");
    }
    expect(getFields.path).toBe("/health");
    expect(getFields.path).not.toContain("?");
    expect(Number.isInteger(getFields.duration)).toBe(true);
    expect(getFields.method).toBe("GET");
    expect(getFields.status).toBe(200);

    info.mockClear();

    const postResponse = await run(
      new Request("https://example.test/health?query-leak-token", {
        method: "POST",
        headers: { "header-leak-token": "header-leak-token" },
        body: "body-leak-token",
      }),
    );
    expect(postResponse.status).toBe(404);
    expect(info).toHaveBeenCalledTimes(1);

    const postFields = info.mock.calls[0]![0];
    for (const value of fieldValues(postFields)) {
      expect(value).not.toContain("query-leak-token");
      expect(value).not.toContain("header-leak-token");
      expect(value).not.toContain("body-leak-token");
    }
    expect(postFields.path).toBe("/health");
    expect(postFields.method).toBe("POST");
    expect(postFields.status).toBe(404);
    expect(Number.isInteger(postFields.duration)).toBe(true);
  });

  it("accepts a UUID x-request-id when acceptInboundRequestId is true", async () => {
    const info = vi.fn();
    const run = createRequestHandler(
      { info, acceptInboundRequestId: true },
      async () => {
        const ctx = getRequestContext();
        expect(ctx.requestId).toBe(INBOUND_UUID);
        expect(ctx.idempotencyKey).toBeUndefined();
        return new Response(null, { status: 204 });
      },
    );

    await run(
      new Request("https://example.test/anything", {
        headers: { "x-request-id": INBOUND_UUID },
      }),
    );
    expect(info).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["missing header", {} as Record<string, string>],
    ["non-uuid header", { "x-request-id": "not-a-uuid" }],
    [
      "acceptInboundRequestId false with uuid header",
      { "x-request-id": REJECTED_UUID },
    ],
  ])("mints requestId when %s", async (_label, headers) => {
    const info = vi.fn();
    const run = createRequestHandler({ info, acceptInboundRequestId: false }, async () => {
      return new Response(null, { status: 204 });
    });

    await run(new Request("https://example.test/anything", { headers }));

    const fields = info.mock.calls[0]![0];
    expect(fields.requestId).toMatch(UUID_RE);
    expect(fields.requestId).not.toBe(REJECTED_UUID);
    for (const value of fieldValues(fields)) {
      expect(value).not.toContain(REJECTED_UUID);
    }
  });

  it("stores a valid Idempotency-Key as clientIdempotencyKey", async () => {
    const info = vi.fn();
    const clientKey = "abc.DEF_123";
    const run = createRequestHandler({ info }, async () => {
      const ctx = getRequestContext();
      expect(ctx.clientIdempotencyKey).toBe(clientKey);
      expect(ctx.idempotencyKey).toBeUndefined();
      return new Response(null, { status: 204 });
    });

    await run(
      new Request("https://example.test/anything", {
        headers: { "Idempotency-Key": clientKey },
      }),
    );

    const fields = info.mock.calls[0]![0];
    for (const value of fieldValues(fields)) {
      expect(value).not.toContain(clientKey);
    }
  });

  it.each([
    ["space", "has space"],
    ["256 chars", "a".repeat(256)],
  ])("ignores invalid Idempotency-Key (%s)", async (_label, key) => {
    const info = vi.fn();
    const run = createRequestHandler({ info }, async () => {
      expect(getRequestContext().clientIdempotencyKey).toBeUndefined();
      return new Response(null, { status: 204 });
    });

    await run(
      new Request("https://example.test/anything", {
        headers: { "Idempotency-Key": key },
      }),
    );

    const fields = info.mock.calls[0]![0];
    for (const value of fieldValues(fields)) {
      expect(value).not.toContain(key);
    }
  });

  it("returns 500 without leaking when handle throws", async () => {
    const info = vi.fn();
    const secret = "secret-stack-token";
    const run = createRequestHandler({ info }, async () => {
      throw new Error(secret);
    });

    const response = await run(new Request("https://example.test/boom"));
    expect(response.status).toBe(500);
    expect(await response.text()).toBe("");

    expect(info).toHaveBeenCalledTimes(1);
    const fields = info.mock.calls[0]![0];
    expect(fields.status).toBe(500);
    for (const value of fieldValues(fields)) {
      expect(value).not.toContain(secret);
    }
  });
});

describe("healthRequest", () => {
  it("returns 200 JSON for GET /health and 404 for POST /health", async () => {
    const get = healthRequest(new Request("https://example.test/health", { method: "GET" }));
    expect(get.status).toBe(200);
    expect(await get.json()).toEqual({ ok: true });

    const post = healthRequest(new Request("https://example.test/health", { method: "POST" }));
    expect(post.status).toBe(404);
    expect(await post.text()).toBe("");
  });
});
