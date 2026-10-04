import { describe, expect, it } from "vitest";

import { checkContext, ContextRejected } from "./context.js";

describe("checkContext", () => {
  it("rejects an empty object", () => {
    expect(() => checkContext({})).toThrow(ContextRejected);
  });

  it("rejects a context missing key_version", () => {
    expect(() =>
      checkContext({
        key_kind: "org",
        org_id: "org-1",
      }),
    ).toThrow(ContextRejected);
  });

  it("rejects a context with both scope keys", () => {
    expect(() =>
      checkContext({
        key_kind: "org",
        org_id: "org-1",
        region: "au",
        key_version: "v1",
      }),
    ).toThrow(ContextRejected);
  });

  it("rejects a context with neither scope key", () => {
    expect(() =>
      checkContext({
        key_kind: "org",
        key_version: "v1",
      }),
    ).toThrow(ContextRejected);
  });

  it("rejects an extra key", () => {
    const context = {
      key_kind: "org" as const,
      org_id: "org-1",
      key_version: "v1",
      extra: "nope",
    };
    expect(() => checkContext(context)).toThrow(ContextRejected);
    try {
      checkContext(context);
    } catch (error) {
      expect(error).toBeInstanceOf(ContextRejected);
      expect((error as Error).message).not.toContain("org-1");
      expect((error as Error).message).not.toContain("nope");
    }
  });

  it("rejects a bad key_kind", () => {
    expect(() =>
      checkContext({
        key_kind: "household",
        org_id: "org-1",
        key_version: "v1",
      }),
    ).toThrow(ContextRejected);
  });

  it("rejects a non-object", () => {
    expect(() => checkContext(null)).toThrow(ContextRejected);
    expect(() => checkContext("context")).toThrow(ContextRejected);
  });

  it("rejects org when region is present instead of org_id", () => {
    expect(() =>
      checkContext({
        key_kind: "org",
        region: "au",
        key_version: "v1",
      }),
    ).toThrow(ContextRejected);
  });

  it("rejects identity when org_id is present instead of region", () => {
    expect(() =>
      checkContext({
        key_kind: "identity",
        org_id: "org-1",
        key_version: "v1",
      }),
    ).toThrow(ContextRejected);
  });

  it("rejects a non-string key_version", () => {
    expect(() =>
      checkContext({
        key_kind: "org",
        org_id: "org-1",
        key_version: 1,
      }),
    ).toThrow(ContextRejected);
  });

  it("accepts an org context", () => {
    expect(
      checkContext({
        key_kind: "org",
        org_id: "org-1",
        key_version: "v1",
      }),
    ).toEqual({
      key_kind: "org",
      org_id: "org-1",
      key_version: "v1",
    });
  });

  it("accepts an identity context", () => {
    expect(
      checkContext({
        key_kind: "identity",
        region: "au",
        key_version: "v1",
      }),
    ).toEqual({
      key_kind: "identity",
      region: "au",
      key_version: "v1",
    });
  });
});
