import { SELF } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("api", () => {
  it("GET /health mints request id instead of trusting inbound x-request-id", async () => {
    const inboundRequestId = "22222222-2222-4222-8222-222222222222";
    const logSpy = vi.spyOn(console, "log");

    const response = await SELF.fetch("https://api.test/health", {
      headers: { "x-request-id": inboundRequestId },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(logSpy).toHaveBeenCalledTimes(1);

    const logLine = String(logSpy.mock.calls[0]![0]);
    const parsed = JSON.parse(logLine) as Record<string, unknown>;
    expect(typeof parsed.requestId).toBe("string");
    expect(parsed.requestId).toMatch(UUID);
    expect(parsed.requestId).not.toBe(inboundRequestId);
    expect(logLine).not.toContain(inboundRequestId);

    logSpy.mockRestore();
  });
});
