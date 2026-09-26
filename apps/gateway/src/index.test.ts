import { SELF } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

describe("gateway", () => {
  it("GET /health logs inbound x-request-id through the kernel handler", async () => {
    const requestId = "11111111-1111-4111-8111-111111111111";
    const logSpy = vi.spyOn(console, "log");

    const response = await SELF.fetch("https://gateway.test/health", {
      headers: { "x-request-id": requestId },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(logSpy).toHaveBeenCalledTimes(1);

    const parsed = JSON.parse(String(logSpy.mock.calls[0]![0])) as Record<string, unknown>;
    expect(parsed.requestId).toBe(requestId);

    logSpy.mockRestore();
  });
});
