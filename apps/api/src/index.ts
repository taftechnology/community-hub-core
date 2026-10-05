import { healthRequest } from "@community-hub/kernel";
import { createLogger } from "@community-hub/observability";

import { createGate } from "./gate.js";

const logger = createLogger();

const gate = createGate({
  hostnames: {
    api: "api.invalid",
    auth: "auth.invalid",
    webhooks: "webhooks.invalid",
    ops: "ops.invalid",
  },
  routes: [
    {
      method: "GET",
      pattern: "/health",
      surface: "all",
      handle: healthRequest,
    },
  ],
  info: (message, fields) => {
    logger.info(message, fields);
  },
});

export default {
  fetch: (request: Request): Promise<Response> => gate({ request, remoteAddress: "127.0.0.1" }),
};
