import { createRequestHandler, healthRequest } from "@community-hub/kernel";
import { createLogger } from "@community-hub/observability";

const logger = createLogger();

export default {
  fetch: createRequestHandler(
    {
      info: (fields) => logger.info("request", fields),
      acceptInboundRequestId: true,
    },
    healthRequest,
  ),
};
