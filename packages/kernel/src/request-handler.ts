import { healthPayload } from "./health.js";
import { getRequestContext, withRequest } from "./request.js";

export type RequestLogFields = {
  method: string;
  path: string;
  status: number;
  duration: number;
  requestId: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLIENT_IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{1,255}$/;

function resolveRequestId(request: Request, acceptInboundRequestId: boolean): string {
  const inbound = request.headers.get("x-request-id");
  if (acceptInboundRequestId && inbound !== null && UUID.test(inbound)) {
    return inbound;
  }
  return crypto.randomUUID();
}

function resolveClientIdempotencyKey(request: Request): string | undefined {
  const raw = request.headers.get("idempotency-key");
  if (raw === null || !CLIENT_IDEMPOTENCY_KEY.test(raw)) {
    return undefined;
  }
  return raw;
}

export function createRequestHandler(
  options: {
    info: (fields: RequestLogFields) => void;
    acceptInboundRequestId?: boolean;
  },
  handle: (request: Request) => Response | Promise<Response>,
): (request: Request) => Promise<Response> {
  const acceptInboundRequestId = options.acceptInboundRequestId ?? false;

  return async (request: Request): Promise<Response> => {
    const requestId = resolveRequestId(request, acceptInboundRequestId);
    const clientIdempotencyKey = resolveClientIdempotencyKey(request);
    const ctx: { requestId: string; clientIdempotencyKey?: string } = { requestId };
    if (clientIdempotencyKey !== undefined) {
      ctx.clientIdempotencyKey = clientIdempotencyKey;
    }

    const started = performance.now();
    let status = 500;

    return withRequest(ctx, async () => {
      try {
        const response = await handle(request);
        status = response.status;
        return response;
      } catch {
        status = 500;
        return new Response(null, { status: 500 });
      } finally {
        options.info({
          method: request.method,
          path: new URL(request.url).pathname,
          status,
          duration: Math.round(performance.now() - started),
          requestId: getRequestContext().requestId,
        });
      }
    });
  };
}

export function healthRequest(request: Request): Response {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/health") {
    return Response.json(healthPayload());
  }
  return new Response(null, { status: 404 });
}
