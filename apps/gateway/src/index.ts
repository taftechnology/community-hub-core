import { healthPayload } from "@community-hub/kernel";
import { createLogger } from "@community-hub/observability";

declare global {
  // Vitest pool workers can redirect logs without crossing isolates.
  var __gatewayTestLogWrite: ((line: string) => void) | undefined;
}

const logger = createLogger({
  write(line) {
    if (globalThis.__gatewayTestLogWrite) {
      globalThis.__gatewayTestLogWrite(line);
      return;
    }
    console.log(line);
  },
});

export default {
  async fetch(request: Request): Promise<Response> {
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
  },
};
