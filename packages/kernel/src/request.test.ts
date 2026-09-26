import { describe, expect, it } from "vitest";

import { getRequestContext, withChangeKey, withRequest } from "./request";

const AGGREGATE = "00000000-0000-7000-8000-0000000000AA";
const AGGREGATE_LOWER = "00000000-0000-7000-8000-0000000000aa";

describe("request context", () => {
  it("throws when getRequestContext is called outside withRequest", () => {
    expect(() => getRequestContext()).toThrow("Request context is missing");
  });

  it("keeps distinct ids for concurrent withRequest calls", async () => {
    const first = { requestId: "req-a" };
    const second = { requestId: "req-b" };

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
    const outer = { requestId: "outer" };
    const inner = { requestId: "inner" };

    await withRequest(outer, async () => {
      expect(getRequestContext()).toEqual(outer);

      await withRequest(inner, async () => {
        expect(getRequestContext()).toEqual(inner);
      });

      expect(getRequestContext()).toEqual(outer);
    });
  });

  it("withChangeKey outside withRequest throws Request context is missing", () => {
    expect(() => {
      void withChangeKey(AGGREGATE, "1", async () => "ok");
    }).toThrow("Request context is missing");
  });

  it("rejects a non-UUID aggregateId without echoing the value", async () => {
    await withRequest({ requestId: "req-1" }, async () => {
      expect(() => {
        void withChangeKey("not-a-uuid", "1", async () => "ok");
      }).toThrow("aggregateId must be a UUID");

      try {
        void withChangeKey("not-a-uuid", "1", async () => "ok");
      } catch (error) {
        expect((error as Error).message).not.toContain("not-a-uuid");
      }
    });
  });

  it.each(["-1", "1.5", "01"])("rejects version %s without echoing the value", async (version) => {
    await withRequest({ requestId: "req-1" }, async () => {
      expect(() => {
        void withChangeKey(AGGREGATE, version, async () => "ok");
      }).toThrow("version must be a non-negative integer");

      try {
        void withChangeKey(AGGREGATE, version, async () => "ok");
      } catch (error) {
        expect((error as Error).message).not.toContain(version);
      }
    });
  });

  it("accepts version 0 and scopes a change key", async () => {
    await withRequest({ requestId: "req-1" }, async () => {
      expect(getRequestContext().idempotencyKey).toBeUndefined();

      await withChangeKey(AGGREGATE, "0", async () => {
        expect(getRequestContext().idempotencyKey).toBe(`change:${AGGREGATE_LOWER}:0`);
      });

      expect(getRequestContext().idempotencyKey).toBeUndefined();
    });
  });

  it("scopes change:<uuid>:1 inside withChangeKey and clears it after", async () => {
    await withRequest({ requestId: "req-1" }, async () => {
      await withChangeKey(AGGREGATE, "1", async () => {
        expect(getRequestContext().idempotencyKey).toBe(`change:${AGGREGATE_LOWER}:1`);
      });

      expect(getRequestContext().idempotencyKey).toBeUndefined();
    });
  });

  it("sibling withChangeKey scopes see distinct keys and not each other", async () => {
    await withRequest({ requestId: "req-1" }, async () => {
      const keys: string[] = [];

      await withChangeKey(AGGREGATE, "1", async () => {
        const key = getRequestContext().idempotencyKey;
        expect(key).toBe(`change:${AGGREGATE_LOWER}:1`);
        keys.push(key!);
      });

      await withChangeKey(AGGREGATE, "2", async () => {
        const key = getRequestContext().idempotencyKey;
        expect(key).toBe(`change:${AGGREGATE_LOWER}:2`);
        keys.push(key!);
        expect(getRequestContext().idempotencyKey).not.toBe(keys[0]);
      });

      expect(keys).toEqual([`change:${AGGREGATE_LOWER}:1`, `change:${AGGREGATE_LOWER}:2`]);
      expect(getRequestContext().idempotencyKey).toBeUndefined();
    });
  });

  it("nested withChangeKey restores the outer key after the inner returns", async () => {
    await withRequest({ requestId: "req-1" }, async () => {
      await withChangeKey(AGGREGATE, "1", async () => {
        expect(getRequestContext().idempotencyKey).toBe(`change:${AGGREGATE_LOWER}:1`);

        await withChangeKey(AGGREGATE, "2", async () => {
          expect(getRequestContext().idempotencyKey).toBe(`change:${AGGREGATE_LOWER}:2`);
        });

        expect(getRequestContext().idempotencyKey).toBe(`change:${AGGREGATE_LOWER}:1`);
      });
    });
  });

  it("derives a client-prefixed key when clientIdempotencyKey is set", async () => {
    const clientKey = "00000000-0000-7000-8000-000000000001:3";
    const aggregate = "00000000-0000-7000-8000-000000000002";

    await withRequest({ requestId: "req-1", clientIdempotencyKey: clientKey }, async () => {
      await withChangeKey(aggregate, "1", async () => {
        expect(getRequestContext().idempotencyKey).toBe(`client:${clientKey}:${aggregate}:1`);
      });
    });
  });
});
