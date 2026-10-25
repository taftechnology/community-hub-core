import { createRequestHandler, type RequestLogFields } from "@community-hub/kernel";

export type Surface = "ops" | "tenant" | "all";
export type BillingMarking = "write" | "read" | "exempt";

export type RouteContext = {
  readonly billing: BillingMarking;
  readonly pattern: string;
};

export type GateRoute = {
  method: string;
  pattern: string;
  surface: Surface;
  billing: BillingMarking;
  handle: (request: Request, context: RouteContext) => Response | Promise<Response>;
  largeBody?: "webhooks";
  static?: true;
};

export class RoutesRejected extends Error {
  readonly code = "routes" as const;

  constructor() {
    super("routes");
    this.name = "RoutesRejected";
  }
}

export type Hostnames = {
  api: string;
  auth: string;
  webhooks: string;
  ops: string;
};

export type GateLogFields = {
  method: string;
  path: string;
  status: number;
  duration?: number;
  requestId?: string;
  gatewayRequestId?: string;
  reason?:
    | "missing_hostname_header"
    | "unknown_hostname"
    | "ops_route_on_other_hostname"
    | "other_route_on_ops_hostname";
  hostname?: string;
  errorClass?: string;
  errorCode?: string;
};

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const GATEWAY_REQUEST_ID = /^[A-Za-z0-9+/=_-]{1,128}$/;
const STATIC_NAME = /^[A-Za-z0-9._-]+$/;

function isValidStaticPattern(pattern: string): boolean {
  if (pattern === "/") {
    return true;
  }
  if (pattern.startsWith("/assets/")) {
    const name = pattern.slice("/assets/".length);
    return name !== "." && name !== ".." && STATIC_NAME.test(name);
  }
  if (pattern.startsWith("/")) {
    const name = pattern.slice("/".length);
    return name !== "." && name !== ".." && STATIC_NAME.test(name);
  }
  return false;
}

export function assertRoutes(routes: readonly GateRoute[]): void {
  const seen = new Set<string>();
  for (const route of routes) {
    if (route.surface !== "ops" && route.surface !== "tenant" && route.surface !== "all") {
      throw new RoutesRejected();
    }
    if (route.billing !== "write" && route.billing !== "read" && route.billing !== "exempt") {
      throw new RoutesRejected();
    }
    if (route.surface === "all" && !(route.method === "GET" && route.pattern === "/health")) {
      throw new RoutesRejected();
    }
    if (
      route.largeBody !== undefined &&
      (route.largeBody !== "webhooks" ||
        route.method !== "POST" ||
        route.pattern !== "/v1/stripe/webhook")
    ) {
      throw new RoutesRejected();
    }
    if (route.static !== undefined) {
      if (
        route.static !== true ||
        route.method !== "GET" ||
        route.surface !== "ops" ||
        route.billing !== "exempt" ||
        route.largeBody !== undefined ||
        !isValidStaticPattern(route.pattern)
      ) {
        throw new RoutesRejected();
      }
    }
    const key = `${route.method} ${route.pattern}`;
    if (seen.has(key)) {
      throw new RoutesRejected();
    }
    seen.add(key);
  }
}

const OPS_HOST_HEADERS: ReadonlyArray<readonly [string, string]> = [
  ["X-Content-Type-Options", "nosniff"],
  ["Referrer-Policy", "same-origin"],
  ["Strict-Transport-Security", "max-age=31536000"],
];

function wrapOpsResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of OPS_HOST_HEADERS) {
    headers.set(name, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function knownHostnames(hostnames: Hostnames): {
  api: string;
  auth: string;
  webhooks: string;
  ops: string;
} {
  return {
    api: hostnames.api.toLowerCase(),
    auth: hostnames.auth.toLowerCase(),
    webhooks: hostnames.webhooks.toLowerCase(),
    ops: hostnames.ops.toLowerCase(),
  };
}

export function presentedHostname(request: Request): string | undefined {
  const raw = request.headers.get("x-community-hub-hostname");
  if (raw === null || raw === "") {
    return undefined;
  }
  return raw.toLowerCase();
}

function gatewayRequestId(request: Request): string | undefined {
  const raw = request.headers.get("x-community-hub-request-id");
  if (raw === null || !GATEWAY_REQUEST_ID.test(raw)) {
    return undefined;
  }
  return raw;
}

async function releaseUnreadBody(request: Request): Promise<void> {
  try {
    await request.body?.cancel();
  } catch {
    // Drop the body. The error text stays out of the log.
  }
}

export function createGate(options: {
  hostnames: Hostnames;
  routes: readonly GateRoute[];
  info: (message: string, fields: GateLogFields) => void;
}): (input: { request: Request; remoteAddress: string }) => Promise<Response> {
  assertRoutes(options.routes);
  const known = knownHostnames(options.hostnames);
  const knownValues = new Set([known.api, known.auth, known.webhooks, known.ops]);

  function match(request: Request): GateRoute | undefined {
    const pathname = new URL(request.url).pathname;
    return options.routes.find(
      (route) => route.method === request.method && route.pattern === pathname,
    );
  }

  const kernel = createRequestHandler(
    {
      info: (fields: RequestLogFields) => {
        options.info("request", fields);
      },
      pathFor: (request) => match(request)?.pattern ?? "unmatched",
      acceptInboundRequestId: false,
    },
    (request) => {
      const route = match(request);
      if (route === undefined) {
        return releaseUnreadBody(request).then(() => new Response(null, { status: 404 }));
      }
      return route.handle(request, { billing: route.billing, pattern: route.pattern });
    },
  );

  return async ({ request, remoteAddress }) => {
    const pathname = new URL(request.url).pathname;
    const matched = match(request);
    const path = matched?.pattern ?? "unmatched";
    const header = presentedHostname(request);

    let reason: GateLogFields["reason"];
    let hostname: string | undefined;

    if (header === undefined) {
      const loopbackHealth =
        request.method === "GET" && pathname === "/health" && LOOPBACK.has(remoteAddress);
      if (!loopbackHealth) {
        reason = "missing_hostname_header";
      }
    } else if (!knownValues.has(header)) {
      reason = "unknown_hostname";
    } else if (matched?.surface === "ops" && header !== known.ops) {
      reason = "ops_route_on_other_hostname";
      hostname = header;
    } else if (header === known.ops && matched?.surface === "tenant") {
      reason = "other_route_on_ops_hostname";
      hostname = header;
    }

    let response: Response;

    if (reason !== undefined) {
      await releaseUnreadBody(request);
      const fields: GateLogFields = {
        method: request.method,
        path,
        status: 404,
        reason,
      };
      if (hostname !== undefined) {
        fields.hostname = hostname;
      }
      const gatewayId = gatewayRequestId(request);
      if (gatewayId !== undefined) {
        fields.gatewayRequestId = gatewayId;
      }
      options.info("request", fields);
      response = new Response(null, { status: 404 });
    } else if (request.method === "OPTIONS" && (header === known.api || header === known.auth)) {
      await releaseUnreadBody(request);
      options.info("request", {
        method: request.method,
        path,
        status: 204,
      });
      response = new Response(null, { status: 204 });
    } else {
      response = await kernel(request);
    }

    if (header === known.ops) {
      return wrapOpsResponse(response);
    }

    return response;
  };
}
