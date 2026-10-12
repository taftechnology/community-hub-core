import { describe, expect, it, vi } from "vitest";

import { getRequestContext } from "./request";
import { createRequestHandler, healthRequest } from "./request-handler";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const INBOUND_UUID = "11111111-1111-4111-8111-111111111111";
const REJECTED_UUID = "22222222-2222-4222-8222-222222222222";

function fieldValues(fields: Record<string, unknown>): string[] {
  return Object.values(fields).map((value) => String(value));
}

function pathFor(request: Request): string {
  return request.method === "GET" && new URL(request.url).pathname === "/health"
    ? "/health"
    : "unmatched";
}

describe("createRequestHandler", () => {
  it("logs one structured line without leaking request parts", async () => {
    const info = vi.fn();
    const run = createRequestHandler({ info, pathFor }, (request) => healthRequest(request));

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
    expect(postFields.path).toBe("unmatched");
    expect(postFields.method).toBe("POST");
    expect(postFields.status).toBe(404);
    expect(Number.isInteger(postFields.duration)).toBe(true);
  });

  it("accepts a UUID x-request-id when acceptInboundRequestId is true", async () => {
    const info = vi.fn();
    const run = createRequestHandler({ info, pathFor, acceptInboundRequestId: true }, async () => {
      const ctx = getRequestContext();
      expect(ctx.requestId).toBe(INBOUND_UUID);
      expect(ctx.idempotencyKey).toBeUndefined();
      return new Response(null, { status: 204 });
    });

    await run(
      new Request("https://example.test/anything", {
        headers: { "x-request-id": INBOUND_UUID },
      }),
    );
    expect(info).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["missing header", {} as Record<string, string>, false],
    ["non-uuid header", { "x-request-id": "not-a-uuid" }, false],
    ["acceptInboundRequestId false with uuid header", { "x-request-id": REJECTED_UUID }, false],
    ["accept inbound with missing header", {} as Record<string, string>, true],
    ["accept inbound with non-uuid header", { "x-request-id": "not-a-uuid" }, true],
    ["accept inbound with email header", { "x-request-id": "person@example.test" }, true],
  ])("mints requestId when %s", async (_label, headers, acceptInboundRequestId) => {
    const info = vi.fn();
    const run = createRequestHandler({ info, pathFor, acceptInboundRequestId }, async () => {
      return new Response(null, { status: 204 });
    });

    await run(new Request("https://example.test/anything", { headers }));

    const fields = info.mock.calls[0]![0];
    const inbound = headers["x-request-id"];
    expect(fields.requestId).toMatch(UUID_RE);
    if (inbound !== undefined) {
      expect(fields.requestId).not.toBe(inbound);
      for (const value of fieldValues(fields)) {
        expect(value).not.toContain(inbound);
      }
    }
  });

  it("stores a valid Idempotency-Key as clientIdempotencyKey", async () => {
    const info = vi.fn();
    const clientKey = "abc.DEF_123";
    const run = createRequestHandler({ info, pathFor }, async () => {
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
    const run = createRequestHandler({ info, pathFor }, async () => {
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
    const run = createRequestHandler({ info, pathFor }, async () => {
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

  describe("a thrown error", () => {
    const MARKERS = {
      message: "marker-message-3f9a",
      stack: "marker-stack-71bc",
      detail: "marker-detail-a2d4 ada@example.test",
      hint: "marker-hint-55e0",
      query: "marker-query-c81f select * from people",
      parameters: "marker-parameters-09aa",
      causeMessage: "marker-cause-message-6d12",
      extra: "marker-extra-property-b7e3",
    };

    class StubDriverError extends Error {
      code: unknown;
      detail = MARKERS.detail;
      hint = MARKERS.hint;
      query = MARKERS.query;
      parameters = [MARKERS.parameters];
      extra = MARKERS.extra;
      constructor(code: unknown, cause?: unknown) {
        super(MARKERS.message, cause === undefined ? undefined : { cause });
        this.name = "StubDriverError";
        this.stack = `StubDriverError: ${MARKERS.stack}`;
        this.code = code;
      }
    }

    async function throwing(thrown: unknown): Promise<{
      response: Response;
      body: string;
      info: ReturnType<typeof vi.fn>;
      serialised: string;
    }> {
      const info = vi.fn();
      const run = createRequestHandler({ info, pathFor }, async () => {
        throw thrown;
      });
      const response = await run(new Request("https://example.test/boom"));
      const body = await response.text();
      return { response, body, info, serialised: JSON.stringify(info.mock.calls) };
    }

    function expectNoMarkers(serialised: string): void {
      for (const marker of Object.values(MARKERS)) {
        expect(serialised).not.toContain(marker);
      }
      expect(serialised).not.toContain("ada@example.test");
      expect(serialised).not.toContain("select *");
    }

    it("logs the class name and code and nothing else from the error", async () => {
      const wrapped = new Error(MARKERS.causeMessage);
      const { response, body, info, serialised } = await throwing(
        new StubDriverError("42P01", wrapped),
      );

      expect(response.status).toBe(500);
      expect(body).toBe("");
      expect(response.headers.get("content-type")).toBeNull();
      expect(info).toHaveBeenCalledTimes(1);
      const fields = info.mock.calls[0]![0] as Record<string, unknown>;
      expect(fields.status).toBe(500);
      expect(fields.errorClass).toBe("StubDriverError");
      expect(fields.errorCode).toBe("42P01");
      expect(Object.keys(fields).sort()).toEqual([
        "duration",
        "errorClass",
        "errorCode",
        "method",
        "path",
        "requestId",
        "status",
      ]);
      expectNoMarkers(serialised);
    });

    it("finds the code on cause when the error has none", async () => {
      const cause = Object.assign(new Error(MARKERS.causeMessage), { code: "28P01" });
      const { info, serialised } = await throwing(new StubDriverError(undefined, cause));
      const fields = info.mock.calls[0]![0] as Record<string, unknown>;
      expect(fields.errorCode).toBe("28P01");
      expectNoMarkers(serialised);
    });

    it("prefers the code on the error over the code on its cause", async () => {
      const cause = Object.assign(new Error(MARKERS.causeMessage), { code: "28P01" });
      const { info } = await throwing(new StubDriverError("42P01", cause));
      expect((info.mock.calls[0]![0] as Record<string, unknown>).errorCode).toBe("42P01");
    });

    it("does not look for a code two levels down", async () => {
      const deepest = Object.assign(new Error(MARKERS.causeMessage), { code: "28P01" });
      const middle = new Error("middle", { cause: deepest });
      const { info, serialised } = await throwing(new StubDriverError(undefined, middle));
      const fields = info.mock.calls[0]![0] as Record<string, unknown>;
      expect("errorCode" in fields).toBe(false);
      expect(fields.errorClass).toBe("StubDriverError");
      expectNoMarkers(serialised);
    });

    it("logs NonError and no marker for a thrown string", async () => {
      const { response, info, serialised } = await throwing(`thrown ${MARKERS.message}`);
      expect(response.status).toBe(500);
      expect(info).toHaveBeenCalledTimes(1);
      const fields = info.mock.calls[0]![0] as Record<string, unknown>;
      expect(fields.errorClass).toBe("NonError");
      expect("errorCode" in fields).toBe(false);
      expectNoMarkers(serialised);
    });

    it("logs NonError for a thrown null or undefined", async () => {
      for (const thrown of [null, undefined]) {
        const { info } = await throwing(thrown);
        const fields = info.mock.calls[0]![0] as Record<string, unknown>;
        expect(fields.errorClass).toBe("NonError");
        expect("errorCode" in fields).toBe(false);
      }
    });

    it("logs Error when the class name is not a plain identifier", async () => {
      const error = new Error(MARKERS.message);
      error.name = `${MARKERS.message} with spaces`;
      const { info, serialised } = await throwing(error);
      const fields = info.mock.calls[0]![0] as Record<string, unknown>;
      expect(fields.errorClass).toBe("Error");
      expectNoMarkers(serialised);
    });

    it("logs Error when the class name is not a string", async () => {
      const error = new Error(MARKERS.message);
      (error as unknown as { name: unknown }).name = { marker: MARKERS.extra };
      const { info, serialised } = await throwing(error);
      expect((info.mock.calls[0]![0] as Record<string, unknown>).errorClass).toBe("Error");
      expectNoMarkers(serialised);
    });

    it.each([
      ["a number", 42],
      ["an object", { marker: MARKERS.extra }],
      ["an array", [MARKERS.extra]],
      ["a lower-case string", "econnrefused"],
      ["a string with spaces", `42P01 ${MARKERS.extra}`],
      ["an over-long string", "A".repeat(41)],
    ])("logs no code when the code is %s", async (_label, code) => {
      const { info, serialised } = await throwing(new StubDriverError(code));
      const fields = info.mock.calls[0]![0] as Record<string, unknown>;
      expect("errorCode" in fields).toBe(false);
      expect(fields.errorClass).toBe("StubDriverError");
      expectNoMarkers(serialised);
    });

    it("logs a 33-character TLS code and a 40-character code, not a 41-character one", async () => {
      const tls = await throwing(new StubDriverError("UNABLE_TO_GET_ISSUER_CERT_LOCALLY"));
      expect((tls.info.mock.calls[0]![0] as Record<string, unknown>).errorCode).toBe(
        "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
      );
      const longest = await throwing(new StubDriverError("A".repeat(40)));
      expect((longest.info.mock.calls[0]![0] as Record<string, unknown>).errorCode).toBe(
        "A".repeat(40),
      );
    });

    it("still returns 500 and logs once when reading the error throws", async () => {
      const hostile = new Error(MARKERS.message);
      Object.defineProperty(hostile, "code", {
        get() {
          throw new Error(MARKERS.causeMessage);
        },
      });
      const { response, body, info, serialised } = await throwing(hostile);
      expect(response.status).toBe(500);
      expect(body).toBe("");
      expect(info).toHaveBeenCalledTimes(1);
      expectNoMarkers(serialised);
    });

    it("logs neither error field for a successful request", async () => {
      const info = vi.fn();
      const run = createRequestHandler(
        { info, pathFor },
        () => new Response(null, { status: 204 }),
      );
      await run(new Request("https://example.test/anything"));
      const fields = info.mock.calls[0]![0] as Record<string, unknown>;
      expect("errorClass" in fields).toBe(false);
      expect("errorCode" in fields).toBe(false);
    });
  });

  it("logs pathFor and a valid gateway request id, not the URL path", async () => {
    const info = vi.fn();
    const marker = "caller-supplied-segment";
    const run = createRequestHandler(
      {
        info,
        pathFor: (request) =>
          new URL(request.url).pathname === "/health" ? "/health" : "unmatched",
      },
      () => new Response(null, { status: 204 }),
    );
    await run(
      new Request(`https://example.test/health/${marker}?query-leak-token`, {
        headers: {
          "x-community-hub-request-id": "gateway-id_1",
          "x-request-id": "22222222-2222-4222-8222-222222222222",
          "x-community-hub-client-ip": "203.0.113.5",
        },
      }),
    );
    const fields = info.mock.calls[0]![0] as Record<string, unknown>;
    expect(fields.path).toBe("unmatched");
    expect(fields.gatewayRequestId).toBe("gateway-id_1");
    expect(fields.requestId).not.toBe("22222222-2222-4222-8222-222222222222");
    expect(JSON.stringify(fields)).not.toContain(marker);
    expect(JSON.stringify(fields)).not.toContain("query-leak-token");
    expect(JSON.stringify(fields)).not.toContain("203.0.113.5");
  });

  it("omits a gateway request id that fails the pattern", async () => {
    const info = vi.fn();
    const run = createRequestHandler(
      {
        info,
        pathFor: () => "unmatched",
      },
      () => new Response(null, { status: 204 }),
    );
    await run(
      new Request("https://example.test/health", {
        headers: { "x-community-hub-request-id": "bad id" },
      }),
    );
    const fields = info.mock.calls[0]![0] as Record<string, unknown>;
    expect(fields.gatewayRequestId).toBeUndefined();
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
