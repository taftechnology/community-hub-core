import { healthPayload } from "@community-hub/kernel";
import { createLogger, type Logger } from "@community-hub/observability";

export function createFetch(logger: Logger) {
  return async function fetch(request: Request): Promise<Response> {
    const started = performance.now();
    const url = new URL(request.url);
    const method = request.method;
    const path = url.pathname;

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
      requestId: crypto.randomUUID(),
    });

    return response;
  };
}

export default {
  fetch: createFetch(createLogger()),
};
