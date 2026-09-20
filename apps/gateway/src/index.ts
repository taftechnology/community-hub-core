import { getRequestContext, healthPayload, withRequest } from "@community-hub/kernel";
import { createLogger, type Logger } from "@community-hub/observability";

export function createFetch(logger: Logger) {
  return async function fetch(request: Request): Promise<Response> {
    const inboundId = request.headers.get("x-request-id");
    const requestId = inboundId ? inboundId : crypto.randomUUID();

    return withRequest({ requestId, idempotencyKey: requestId }, async () => {
      const started = performance.now();
      const url = new URL(request.url);
      const method = request.method;
      const path = url.pathname;
      const context = getRequestContext();

      if (method === "GET" && path === "/health" && context.idempotencyKey !== context.requestId) {
        throw new Error("idempotencyKey must equal requestId");
      }

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
