import { createRequestHandler, healthRequest } from "@community-hub/kernel";
import { createLogger } from "@community-hub/observability";

const logger = createLogger();

function pathFor(request: Request): string {
  const pathname = new URL(request.url).pathname;
  if (request.method === "GET" && pathname === "/health") {
    return "/health";
  }
  return "unmatched";
}

export default {
  fetch: createRequestHandler(
    {
      info: (fields) => logger.info("request", fields),
      pathFor,
      acceptInboundRequestId: false,
    },
    healthRequest,
  ),
};
