import { createLogger } from "@community-hub/observability";
import { describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

import { createGate, RoutesRejected, assertRoutes, type GateRoute, type Surface } from "./gate.js";

const HOSTS = {
  api: "au.api.example.test",
  auth: "auth.au.example.test",
  webhooks: "webhooks.au.example.test",
  ops: "ops.au.example.test",
};

type Line = Record<string, unknown>;

function routes(spies: {
  health: Mock<(request: Request) => void>;
  ops: Mock<(request: Request) => void>;
  tenant: Mock<(request: Request) => void>;
}): GateRoute[] {
  return [
    {
      method: "GET",
      pattern: "/health",
      surface: "all",
      handle: (request) => {
        spies.health(request);
        return Response.json({ ok: true });
      },
    },
    {
      method: "GET",
      pattern: "/ops-only",
      surface: "ops",
      handle: (request) => {
        spies.ops(request);
        return new Response(null, { status: 204 });
      },
    },
    {
      method: "GET",
      pattern: "/tenant-only",
      surface: "tenant",
      handle: (request) => {
        spies.tenant(request);
        return new Response(null, { status: 204 });
      },
    },
  ];
}

describe("createGate", () => {
  function setup() {
    const lines: Line[] = [];
    const spies: {
      health: Mock<(request: Request) => void>;
      ops: Mock<(request: Request) => void>;
      tenant: Mock<(request: Request) => void>;
    } = {
      health: vi.fn(),
      ops: vi.fn(),
      tenant: vi.fn(),
    };
    const gate = createGate({
      hostnames: HOSTS,
      routes: routes(spies),
      info: (_message, fields) => {
        lines.push(fields as unknown as Line);
      },
    });
    return { gate, lines, spies };
  }

  async function call(
    gate: ReturnType<typeof setup>["gate"],
    remote: string,
    header: string | undefined,
    method: string,
    path: string,
    extra?: Record<string, string>,
  ): Promise<Response> {
    const headers = new Headers(extra);
    if (header !== undefined) {
      headers.set("x-community-hub-hostname", header);
    }
    return gate({
      request: new Request(`https://api.test${path}`, { method, headers }),
      remoteAddress: remote,
    });
  }

  it.each([
    ["10.0.0.8", undefined, "GET", "/health", 404, "missing_hostname_header", "/health", false],
    ["127.0.0.1", undefined, "GET", "/health", 200, undefined, "/health", true],
    ["::1", undefined, "GET", "/health", 200, undefined, "/health", true],
    ["::ffff:127.0.0.1", undefined, "GET", "/health", 200, undefined, "/health", true],
    ["10.0.0.8", "OPS.AU.EXAMPLE.TEST", "GET", "/health", 200, undefined, "/health", true],
    ["10.0.0.8", "evil.example", "GET", "/health", 404, "unknown_hostname", "/health", false],
    [
      "10.0.0.8",
      "au.api.example.test",
      "GET",
      "/ops-only",
      404,
      "ops_route_on_other_hostname",
      "/ops-only",
      false,
    ],
    [
      "10.0.0.8",
      "ops.au.example.test",
      "GET",
      "/tenant-only",
      404,
      "other_route_on_ops_hostname",
      "/tenant-only",
      false,
    ],
    ["10.0.0.8", "ops.au.example.test", "GET", "/missing", 404, undefined, "unmatched", true],
    ["10.0.0.8", "auth.au.example.test", "GET", "/missing", 404, undefined, "unmatched", true],
  ] as const)(
    "%s %s %s %s",
    async (remote, header, method, path, status, reason, loggedPath, kernel) => {
      const { gate, lines, spies } = setup();
      const response = await call(gate, remote, header, method, path);
      expect(response.status).toBe(status);
      expect(lines).toHaveLength(1);
      expect(lines[0]?.path).toBe(loggedPath);
      expect(lines[0]?.reason).toBe(reason);
      if (kernel) {
        expect(lines[0]?.requestId).toEqual(expect.any(String));
      } else {
        expect(lines[0]?.requestId).toBeUndefined();
        expect(lines[0]?.duration).toBeUndefined();
        expect(spies.health).not.toHaveBeenCalled();
        expect(spies.ops).not.toHaveBeenCalled();
        expect(spies.tenant).not.toHaveBeenCalled();
      }
      if (reason === "ops_route_on_other_hostname" || reason === "other_route_on_ops_hostname") {
        expect(lines[0]?.hostname).toBe(header);
      }
      if (reason === "unknown_hostname") {
        expect(lines[0]?.hostname).toBeUndefined();
      }
    },
  );

  it("logs a gateway request id on a known-host refusal and omits an unknown hostname", async () => {
    const { gate, lines } = setup();
    const refused = await call(gate, "10.0.0.8", "au.api.example.test", "GET", "/ops-only", {
      "x-community-hub-request-id": "gateway-id_1",
    });
    expect(refused.status).toBe(404);
    expect(lines[0]?.gatewayRequestId).toBe("gateway-id_1");
    expect(lines[0]?.hostname).toBe("au.api.example.test");
    expect(lines[0]?.requestId).toBeUndefined();
    expect(lines[0]?.duration).toBeUndefined();

    const unknown = await call(gate, "10.0.0.8", "evil.example", "GET", "/health", {
      "x-community-hub-request-id": "gateway-id_1",
    });
    expect(unknown.status).toBe(404);
    expect(lines[1]?.reason).toBe("unknown_hostname");
    expect(lines[1]?.hostname).toBeUndefined();
    expect(lines[1]?.gatewayRequestId).toBe("gateway-id_1");
  });

  it("omits the client IP from served, refused, and unmatched lines", async () => {
    const { gate, lines } = setup();
    const extra = { "x-community-hub-client-ip": "203.0.113.9" };
    await call(gate, "127.0.0.1", undefined, "GET", "/health", extra);
    await call(gate, "10.0.0.8", undefined, "GET", "/health", extra);
    await call(gate, "10.0.0.8", "au.api.example.test", "GET", "/missing", extra);
    expect(JSON.stringify(lines)).not.toContain("203.0.113.9");
  });

  it("answers OPTIONS on the api and auth hostnames and leaves POST alone", async () => {
    const lines: Line[] = [];
    const role = vi.fn(() => new Response("granted", { status: 200 }));
    const signIn = vi.fn(() => new Response(null, { status: 204 }));
    const gate = createGate({
      hostnames: HOSTS,
      routes: [
        {
          method: "POST",
          pattern: "/v1/access/grants",
          surface: "tenant",
          handle: () => {
            role();
            return new Response("granted", { status: 200 });
          },
        },
        {
          method: "POST",
          pattern: "/v1/auth/email-otp/start",
          surface: "tenant",
          handle: () => {
            signIn();
            return new Response(null, { status: 204 });
          },
        },
      ],
      info: (_message, fields) => {
        lines.push(fields as unknown as Line);
      },
    });

    const roleOptions = await call(
      gate,
      "10.0.0.8",
      "au.api.example.test",
      "OPTIONS",
      "/v1/access/grants",
    );
    expect(roleOptions.status).toBe(204);
    expect(await roleOptions.text()).toBe("");
    expect(roleOptions.headers.get("access-control-allow-origin")).toBeNull();
    expect(roleOptions.headers.get("access-control-allow-methods")).toBeNull();
    expect(roleOptions.headers.get("access-control-allow-headers")).toBeNull();
    expect(roleOptions.headers.get("access-control-allow-credentials")).toBeNull();
    expect(role).not.toHaveBeenCalled();

    const signInOptions = await call(
      gate,
      "10.0.0.8",
      "auth.au.example.test",
      "OPTIONS",
      "/v1/auth/email-otp/start",
    );
    expect(signInOptions.status).toBe(204);
    expect(await signInOptions.text()).toBe("");
    expect(signIn).not.toHaveBeenCalled();

    const unknown = await call(gate, "10.0.0.8", "evil.example", "OPTIONS", "/v1/access/grants");
    expect(unknown.status).toBe(404);
    expect(lines.some((line) => line.reason === "unknown_hostname")).toBe(true);

    const rolePost = await call(
      gate,
      "10.0.0.8",
      "au.api.example.test",
      "POST",
      "/v1/access/grants",
    );
    expect(rolePost.status).toBe(200);
    expect(await rolePost.text()).toBe("granted");
    expect(role).toHaveBeenCalledOnce();

    const signInPost = await call(
      gate,
      "10.0.0.8",
      "auth.au.example.test",
      "POST",
      "/v1/auth/email-otp/start",
    );
    expect(signInPost.status).toBe(204);
    expect(signIn).toHaveBeenCalledOnce();
  });

  it("logs unmatched for OPTIONS and omits an id in the path", async () => {
    const { gate, lines } = setup();
    const id = "00000000-0000-7000-8000-000000000001";
    const response = await call(
      gate,
      "10.0.0.8",
      "au.api.example.test",
      "OPTIONS",
      `/v1/people/${id}/notes`,
    );
    expect(response.status).toBe(204);
    const line = lines.find((entry) => entry.method === "OPTIONS");
    expect(line?.path).toBe("unmatched");
    expect(JSON.stringify(lines)).not.toContain(id);
  });

  it("does not answer OPTIONS on the ops or webhooks hostnames", async () => {
    const { gate } = setup();
    const ops = await call(gate, "10.0.0.8", "ops.au.example.test", "OPTIONS", "/v1/access/grants");
    const webhooks = await call(
      gate,
      "10.0.0.8",
      "webhooks.au.example.test",
      "OPTIONS",
      "/v1/access/grants",
    );
    expect(ops.status).not.toBe(204);
    expect(webhooks.status).not.toBe(204);
  });

  it("does not read a 1 MiB refused body", async () => {
    const { gate, lines } = setup();
    let reads = 0;
    const marker = "body-marker-not-in-logs";
    const body = new ReadableStream({
      pull(controller) {
        reads += 1;
        controller.enqueue(new TextEncoder().encode(marker.repeat(20_000)));
        controller.close();
      },
    });
    const request = new Request("https://api.test/health", {
      method: "POST",
      body,
      duplex: "half",
      headers: { "x-community-hub-client-ip": "203.0.113.9" },
    });
    const response = await gate({ request, remoteAddress: "10.0.0.8" });
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
    expect(reads).toBe(0);
    expect(JSON.stringify(lines)).not.toContain(marker);
  });
});

describe("createGate when a route throws", () => {
  it("writes one request line with the error class and code and none of the error text", async () => {
    const written: string[] = [];
    const logger = createLogger({ write: (line) => written.push(line) });
    const marker = "marker-secret-7c1e ada@example.test select * from people";
    const gate = createGate({
      hostnames: HOSTS,
      routes: [
        {
          method: "GET",
          pattern: "/boom",
          surface: "tenant",
          handle: () => {
            throw Object.assign(new Error(marker), {
              name: "PostgresError",
              code: "42P01",
              detail: marker,
              query: marker,
            });
          },
        },
      ],
      info: (message, fields) => {
        logger.info(message, fields);
      },
    });

    const response = await gate({
      request: new Request("http://127.0.0.1/boom", {
        headers: { "x-community-hub-hostname": HOSTS.api },
      }),
      remoteAddress: "10.0.0.1",
    });

    expect(response.status).toBe(500);
    expect(await response.text()).toBe("");
    expect(written).toHaveLength(1);
    const line = JSON.parse(written[0] ?? "{}") as Record<string, unknown>;
    expect(line).toMatchObject({
      message: "request",
      method: "GET",
      path: "/boom",
      status: 500,
      errorClass: "PostgresError",
      errorCode: "42P01",
    });
    expect(written[0]).not.toContain("marker-secret-7c1e");
    expect(written[0]).not.toContain("ada@example.test");
    expect(written[0]).not.toContain("select *");
    expect(logger.getDroppedFieldCount()).toBe(0);
  });
});

describe("assertRoutes", () => {
  it("rejects all on any route other than GET /health and a duplicate method and pattern", () => {
    const handle = () => new Response(null, { status: 204 });
    expect(() =>
      assertRoutes([{ method: "GET", pattern: "/other", surface: "all", handle }]),
    ).toThrow(RoutesRejected);
    expect(() =>
      assertRoutes([
        { method: "GET", pattern: "/health", surface: "all", handle },
        { method: "GET", pattern: "/health", surface: "all", handle },
      ]),
    ).toThrow(RoutesRejected);
    expect(() =>
      assertRoutes([
        {
          method: "GET",
          pattern: "/health",
          surface: undefined as unknown as Surface,
          handle,
        },
      ]),
    ).toThrow(RoutesRejected);
  });
});
