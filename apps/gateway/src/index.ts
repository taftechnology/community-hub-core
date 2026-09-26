import { getRequestContext, healthPayload, withRequest } from "@community-hub/kernel";
import { createLogger, type Logger } from "@community-hub/observability";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requestIdFromHeader(inboundId: string | null): string {
  if (inboundId && UUID.test(inboundId)) {
    return inboundId;
  }
  return crypto.randomUUID();
}

export function createFetch(logger: Logger) {
  return async function fetch(request: Request): Promise<Response> {
    const requestId = requestIdFromHeader(request.headers.get("x-request-id"));

    return withRequest({ requestId }, async () => {
      const started = performance.now();
      const url = new URL(request.url);
      const method = request.method;
      const path = url.pathname;
      const context = getRequestContext();

      let response: Response;
      if (method === "GET" && path === "/health") {
        response = Response.json(healthPayload());
      } else {
        response = new Response(null, { status: 404 });
      }

      logger.info("request", {
        method,
        path,
        status: response.status,
        duration: Math.round(performance.now() - started),
        requestId: context.requestId,
      });

      return response;
    });
  };
}

export default {
  fetch: createFetch(createLogger()),
};
