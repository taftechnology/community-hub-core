import { healthPayload } from "./health.js";
import { getRequestContext, withRequest } from "./request.js";

export type RequestLogFields = {
  method: string;
  path: string;
  status: number;
  duration: number;
  requestId: string;
  gatewayRequestId?: string;
  /** Class name of an error a handler threw. Present only on a thrown error. */
  errorClass?: string;
  /** Short upper-case code of an error a handler threw. Present only when it has one. */
  errorCode?: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLIENT_IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{1,255}$/;
const GATEWAY_REQUEST_ID = /^[A-Za-z0-9+/=_-]{1,128}$/;
const ERROR_CLASS = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const ERROR_CODE = /^[A-Z0-9_]{1,32}$/;

type ThrownError = { errorClass: string; errorCode?: string };

function codeOf(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const code: unknown = (value as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/**
 * Reduces a thrown value to a class name and a short code. Nothing else about the error is read:
 * its message, stack, cause text and driver properties can hold SQL, parameters or a person's
 * details, so they never reach the log (AGENTS.md section 1, rule 5).
 */
function describeThrown(error: unknown): ThrownError {
  try {
    let errorClass = "NonError";
    if (error instanceof Error) {
      const name: unknown = error.name;
      errorClass = typeof name === "string" && ERROR_CLASS.test(name) ? name : "Error";
    }
    const raw = codeOf(error) ?? codeOf((error as { cause?: unknown } | null)?.cause);
    if (raw !== undefined && ERROR_CODE.test(raw)) {
      return { errorClass, errorCode: raw };
    }
    return { errorClass };
  } catch {
    return { errorClass: "Error" };
  }
}

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

function resolveGatewayRequestId(request: Request): string | undefined {
  const raw = request.headers.get("x-community-hub-request-id");
  if (raw === null || !GATEWAY_REQUEST_ID.test(raw)) {
    return undefined;
  }
  return raw;
}

export function createRequestHandler(
  options: {
    info: (fields: RequestLogFields) => void;
    pathFor: (request: Request) => string;
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
    let thrown: ThrownError | undefined;

    return withRequest(ctx, async () => {
      try {
        const response = await handle(request);
        status = response.status;
        return response;
      } catch (error) {
        status = 500;
        thrown = describeThrown(error);
        return new Response(null, { status: 500 });
      } finally {
        const fields: RequestLogFields = {
          method: request.method,
          path: options.pathFor(request),
          status,
          duration: Math.round(performance.now() - started),
          requestId: getRequestContext().requestId,
        };
        if (thrown !== undefined) {
          fields.errorClass = thrown.errorClass;
          if (thrown.errorCode !== undefined) {
            fields.errorCode = thrown.errorCode;
          }
        }
        const gatewayRequestId = resolveGatewayRequestId(request);
        if (gatewayRequestId !== undefined) {
          fields.gatewayRequestId = gatewayRequestId;
        }
        options.info(fields);
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
