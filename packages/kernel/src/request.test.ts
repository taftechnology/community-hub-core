import { describe, expect, it } from "vitest";

import { getRequestContext, withRequest } from "./request";

describe("request context", () => {
  it("throws when getRequestContext is called outside withRequest", () => {
    expect(() => getRequestContext()).toThrow();
  });

  it("keeps distinct ids for concurrent withRequest calls", async () => {
    const first = { requestId: "req-a", idempotencyKey: "idem-a" };
    const second = { requestId: "req-b", idempotencyKey: "idem-b" };

    const [gotFirst, gotSecond] = await Promise.all([
      withRequest(first, async () => {
        await Promise.resolve();
        return getRequestContext();
      }),
      withRequest(second, async () => {
        await Promise.resolve();
        return getRequestContext();
      }),
    ]);

    expect(gotFirst).toEqual(first);
    expect(gotSecond).toEqual(second);
  });

  it("nested withRequest sees the inner context and restores the outer after", async () => {
    const outer = { requestId: "outer", idempotencyKey: "outer-key" };
    const inner = { requestId: "inner", idempotencyKey: "inner-key" };

    await withRequest(outer, async () => {
      expect(getRequestContext()).toEqual(outer);

      await withRequest(inner, async () => {
        expect(getRequestContext()).toEqual(inner);
      });

      expect(getRequestContext()).toEqual(outer);
    });
  });
});
