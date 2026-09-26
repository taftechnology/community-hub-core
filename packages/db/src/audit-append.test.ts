import { describe, expect, it, vi } from "vitest";

import { insertWithSeqRetry } from "./audit-append.js";

describe("insertWithSeqRetry", () => {
  it("retries a seq unique 23505 five times then throws", async () => {
    const error = { code: "23505", constraint_name: "audit_events_org_id_seq_unique" };
    const attempt = vi.fn(async () => {
      throw error;
    });

    await expect(insertWithSeqRetry(attempt)).rejects.toBe(error);
    expect(attempt).toHaveBeenCalledTimes(5);
  });

  it("throws on the first 23505 for any other constraint", async () => {
    const error = { code: "23505", constraint_name: "audit_events_pkey" };
    const attempt = vi.fn(async () => {
      throw error;
    });

    await expect(insertWithSeqRetry(attempt)).rejects.toBe(error);
    expect(attempt).toHaveBeenCalledTimes(1);
  });
});
