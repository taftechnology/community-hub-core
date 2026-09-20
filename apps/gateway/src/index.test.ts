import { healthPayload } from "@community-hub/kernel";
import { createLogger } from "@community-hub/observability";
import { createExecutionContext, SELF, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createFetch } from "./index";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe("gateway", () => {
  it("GET /health returns kernel healthPayload", async () => {
    const response = await SELF.fetch("https://gateway.test/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(healthPayload());
  });

  it("GET unknown path returns 404 with empty body", async () => {
    const response = await SELF.fetch("https://gateway.test/anything-else");
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
  });

  it("emits one structured log line without query, headers, or body", async () => {
    const queryToken = "query-leak-token";
    const headerToken = "header-leak-token";
    const bodyToken = "body-leak-token";
    const logLines: string[] = [];
    const logger = createLogger({ write: (line) => logLines.push(line) });
    const fetchHandler = createFetch(logger);

    const request = new IncomingRequest(`https://gateway.test/health?secret=${queryToken}`, {
      method: "POST",
      headers: {
        "X-Secret": headerToken,
        "Content-Type": "text/plain",
      },
      body: bodyToken,
    });
    const ctx = createExecutionContext();
    const response = await fetchHandler(request, {}, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(404);

    expect(logLines).toHaveLength(1);
    const raw = logLines[0];
    expect(raw).not.toContain(queryToken);
    expect(raw).not.toContain(headerToken);
    expect(raw).not.toContain(bodyToken);

    const parsed = JSON.parse(raw!) as Record<string, unknown>;
    expect(parsed.method).toBe("POST");
    expect(parsed.path).toBe("/health");
    expect(parsed.status).toBe(404);
    expect(typeof parsed.duration).toBe("number");
    expect(typeof parsed.requestId).toBe("string");
    expect(String(parsed.requestId).length).toBeGreaterThan(0);

    const keys = Object.keys(parsed).sort();
    expect(keys).toEqual(["duration", "level", "message", "method", "path", "requestId", "status"]);
  });

  it("GET /health logs requestId from ALS and keeps idempotencyKey equal", async () => {
    const inboundId = "11111111-1111-4111-8111-111111111111";
    const logLines: string[] = [];
    const logger = createLogger({ write: (line) => logLines.push(line) });
    const fetchHandler = createFetch(logger);

    const request = new IncomingRequest("https://gateway.test/health", {
      headers: { "x-request-id": inboundId },
    });
    const ctx = createExecutionContext();
    const response = await fetchHandler(request, {}, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(healthPayload());

    expect(logLines).toHaveLength(1);
    const parsed = JSON.parse(logLines[0]!) as Record<string, unknown>;
    expect(parsed.requestId).toBe(inboundId);
    expect(String(parsed.requestId)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );

    const keys = Object.keys(parsed).sort();
    expect(keys).toEqual(["duration", "level", "message", "method", "path", "requestId", "status"]);
  });

  it("mints a UUID requestId when x-request-id is absent", async () => {
    const logLines: string[] = [];
    const logger = createLogger({ write: (line) => logLines.push(line) });
    const fetchHandler = createFetch(logger);

    const request = new IncomingRequest("https://gateway.test/health");
    const ctx = createExecutionContext();
    const response = await fetchHandler(request, {}, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(healthPayload());

    expect(logLines).toHaveLength(1);
    const parsed = JSON.parse(logLines[0]!) as Record<string, unknown>;
    expect(String(parsed.requestId)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });
});
