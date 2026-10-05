import { describe, expect, it, vi } from "vitest";

import { createGate, RoutesRejected, assertRoutes, type GateRoute, type Surface } from "./gate.js";

const HOSTS = {
  api: "au.api.example.test",
  auth: "auth.au.example.test",
  webhooks: "webhooks.au.example.test",
  ops: "ops.au.example.test",
};

type Line = Record<string, unknown>;

function routes(spies: {
  health: ReturnType<typeof vi.fn>;
  ops: ReturnType<typeof vi.fn>;
  tenant: ReturnType<typeof vi.fn>;
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
    const spies = {
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
