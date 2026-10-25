import { describe, expect, it } from "vitest";

import {
  clearSessionCookies,
  originAllowed,
  readJson,
  readOpsCookie,
  setSessionCookies,
} from "./ops-cookies.js";

describe("ops cookies", () => {
  it("sets session cookies with the full attribute set", () => {
    const headers = new Headers();
    setSessionCookies(headers, { access: "access-token-123", refresh: "refresh-token-456" });

    const cookies = headers.getSetCookie();
    expect(cookies).toEqual([
      "__Host-ops_at=access-token-123; Secure; HttpOnly; SameSite=Strict; Path=/",
      "__Host-ops_rt=refresh-token-456; Secure; HttpOnly; SameSite=Strict; Path=/",
    ]);

    for (const cookie of cookies) {
      expect(cookie).not.toMatch(/Max-Age/i);
      expect(cookie).not.toMatch(/Expires/i);
      expect(cookie).not.toMatch(/Domain/i);
    }

    const singleHeaders = new Headers();
    setSessionCookies(singleHeaders, { access: "access-only-token" });
    expect(singleHeaders.getSetCookie()).toEqual([
      "__Host-ops_at=access-only-token; Secure; HttpOnly; SameSite=Strict; Path=/",
    ]);

    const clearHeaders = new Headers();
    clearSessionCookies(clearHeaders);
    expect(clearHeaders.getSetCookie()).toEqual([
      "__Host-ops_at=; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
      "__Host-ops_rt=; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
    ]);
  });

  it("treats duplicate and malformed cookies as absent", () => {
    // duplicated name
    const reqDuplicate = new Request("https://ops.example.test", {
      headers: { cookie: "__Host-ops_at=first; __Host-ops_at=second" },
    });
    expect(readOpsCookie(reqDuplicate, "__Host-ops_at")).toBeUndefined();

    // a pair without '='
    const reqNoEquals = new Request("https://ops.example.test", {
      headers: { cookie: "__Host-ops_at" },
    });
    expect(readOpsCookie(reqNoEquals, "__Host-ops_at")).toBeUndefined();

    const reqMalformedOther = new Request("https://ops.example.test", {
      headers: { cookie: "malformed; __Host-ops_at=valid-token" },
    });
    expect(readOpsCookie(reqMalformedOther, "__Host-ops_at")).toBeUndefined();

    // value with characters outside [A-Za-z0-9_-]
    const invalidValues = [
      "bad@val",
      "bad/val",
      "bad+val",
      "bad=val",
      "bad val",
      "bad;val",
      "bad%val",
    ];
    for (const val of invalidValues) {
      const req = new Request("https://ops.example.test", {
        headers: { cookie: `__Host-ops_at=${val}` },
      });
      expect(readOpsCookie(req, "__Host-ops_at")).toBeUndefined();
    }

    // empty value
    const reqEmpty = new Request("https://ops.example.test", {
      headers: { cookie: "__Host-ops_at=" },
    });
    expect(readOpsCookie(reqEmpty, "__Host-ops_at")).toBeUndefined();

    // no Cookie header
    const reqNoHeader = new Request("https://ops.example.test");
    expect(readOpsCookie(reqNoHeader, "__Host-ops_at")).toBeUndefined();

    // well-formed header with other cookies around it
    const reqSurrounded = new Request("https://ops.example.test", {
      headers: {
        cookie: "other=val; __Host-ops_at=session_token-123; third=abc",
      },
    });
    expect(readOpsCookie(reqSurrounded, "__Host-ops_at")).toBe("session_token-123");

    const reqRefresh = new Request("https://ops.example.test", {
      headers: {
        cookie: "alpha=1; __Host-ops_rt=refresh_token-456; beta=2",
      },
    });
    expect(readOpsCookie(reqRefresh, "__Host-ops_rt")).toBe("refresh_token-456");
  });

  it("allows only the exact expected origin case-insensitively and rejects all else", () => {
    const opsHost = "ops.example.test";

    // true only for https://ops.example.test (case-insensitive host)
    expect(
      originAllowed(
        new Request("https://ops.example.test", {
          headers: { origin: "https://ops.example.test" },
        }),
        opsHost,
      ),
    ).toBe(true);

    expect(
      originAllowed(
        new Request("https://ops.example.test", {
          headers: { origin: "https://OPS.EXAMPLE.TEST" },
        }),
        opsHost,
      ),
    ).toBe(true);

    expect(
      originAllowed(
        new Request("https://ops.example.test", {
          headers: { origin: "https://ops.example.test" },
        }),
        "OPS.EXAMPLE.TEST",
      ),
    ).toBe(true);

    // false for missing
    expect(originAllowed(new Request("https://ops.example.test"), opsHost)).toBe(false);

    // false for null
    expect(
      originAllowed(
        new Request("https://ops.example.test", {
          headers: { origin: "null" },
        }),
        opsHost,
      ),
    ).toBe(false);

    // false for http://ops.example.test
    expect(
      originAllowed(
        new Request("https://ops.example.test", {
          headers: { origin: "http://ops.example.test" },
        }),
        opsHost,
      ),
    ).toBe(false);

    // false for https://ops.example.test/
    expect(
      originAllowed(
        new Request("https://ops.example.test", {
          headers: { origin: "https://ops.example.test/" },
        }),
        opsHost,
      ),
    ).toBe(false);

    // false for https://ops.example.test:443
    expect(
      originAllowed(
        new Request("https://ops.example.test", {
          headers: { origin: "https://ops.example.test:443" },
        }),
        opsHost,
      ),
    ).toBe(false);

    // false for https://api.example.test
    expect(
      originAllowed(
        new Request("https://ops.example.test", {
          headers: { origin: "https://api.example.test" },
        }),
        opsHost,
      ),
    ).toBe(false);
  });

  it("reads JSON request body matching schema and returns undefined for non-JSON, array, or schema failures", async () => {
    const schema = {
      safeParse(
        data: unknown,
      ): { success: true; data: { name: string; count: number } } | { success: false } {
        if (typeof data !== "object" || data === null || Array.isArray(data)) {
          return { success: false };
        }
        const record = data as Record<string, unknown>;
        const keys = Object.keys(record);
        if (keys.length !== 2 || !("name" in record) || !("count" in record)) {
          return { success: false };
        }
        if (typeof record.name !== "string" || record.name.length === 0) {
          return { success: false };
        }
        if (typeof record.count !== "number" || !Number.isInteger(record.count)) {
          return { success: false };
        }
        return { success: true, data: { name: record.name, count: record.count } };
      },
    };

    // Valid body
    const validReq = new Request("https://ops.example.test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "item", count: 42 }),
    });
    await expect(readJson(validReq, schema)).resolves.toEqual({ name: "item", count: 42 });

    // Valid with charset in content-type
    const charsetReq = new Request("https://ops.example.test", {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ name: "item", count: 42 }),
    });
    await expect(readJson(charsetReq, schema)).resolves.toEqual({ name: "item", count: 42 });

    // Non-JSON content-type
    const textReq = new Request("https://ops.example.test", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ name: "item", count: 42 }),
    });
    await expect(readJson(textReq, schema)).resolves.toBeUndefined();

    // Missing content-type
    const noContentTypeReq = new Request("https://ops.example.test", {
      method: "POST",
      body: JSON.stringify({ name: "item", count: 42 }),
    });
    await expect(readJson(noContentTypeReq, schema)).resolves.toBeUndefined();

    // Invalid JSON syntax
    const badJsonReq = new Request("https://ops.example.test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ not json",
    });
    await expect(readJson(badJsonReq, schema)).resolves.toBeUndefined();

    // JSON array
    const arrayReq = new Request("https://ops.example.test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([1, 2, 3]),
    });
    await expect(readJson(arrayReq, schema)).resolves.toBeUndefined();

    // Body failing schema (extra key)
    const extraKeyReq = new Request("https://ops.example.test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "item", count: 42, extra: 1 }),
    });
    await expect(readJson(extraKeyReq, schema)).resolves.toBeUndefined();

    // Body failing schema (missing key)
    const missingKeyReq = new Request("https://ops.example.test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "item" }),
    });
    await expect(readJson(missingKeyReq, schema)).resolves.toBeUndefined();

    // Body failing schema (wrong type)
    const wrongTypeReq = new Request("https://ops.example.test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "item", count: "42" }),
    });
    await expect(readJson(wrongTypeReq, schema)).resolves.toBeUndefined();
  });
});
