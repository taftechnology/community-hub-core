import { afterEach, describe, expect, it } from "vitest";

import { stored, watchStorage } from "./test-support.js";

describe("watchStorage positive controls", () => {
  afterEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it("detects setItem on localStorage and sessionStorage", () => {
    const watcher = watchStorage();
    try {
      localStorage.setItem("test-local-key", "local-val");
      sessionStorage.setItem("test-session-key", "session-val");

      expect(watcher.calls).toContainEqual({
        type: "local",
        method: "setItem",
        key: "test-local-key",
        value: "local-val",
      });
      expect(watcher.calls).toContainEqual({
        type: "session",
        method: "setItem",
        key: "test-session-key",
        value: "session-val",
      });
    } finally {
      watcher.restore();
    }
  });

  it("detects removeItem on localStorage and sessionStorage", () => {
    const watcher = watchStorage();
    try {
      localStorage.removeItem("test-local-key");
      sessionStorage.removeItem("test-session-key");

      expect(watcher.calls).toContainEqual({
        type: "local",
        method: "removeItem",
        key: "test-local-key",
      });
      expect(watcher.calls).toContainEqual({
        type: "session",
        method: "removeItem",
        key: "test-session-key",
      });
    } finally {
      watcher.restore();
    }
  });

  it("detects clear on localStorage and sessionStorage", () => {
    const watcher = watchStorage();
    try {
      localStorage.clear();
      sessionStorage.clear();

      expect(watcher.calls).toContainEqual({
        type: "local",
        method: "clear",
      });
      expect(watcher.calls).toContainEqual({
        type: "session",
        method: "clear",
      });
    } finally {
      watcher.restore();
    }
  });

  it("detects document.cookie writes", () => {
    const watcher = watchStorage();
    try {
      document.cookie = "ops-test-cookie=123";

      expect(watcher.calls).toContainEqual({
        type: "cookie",
        value: "ops-test-cookie=123",
      });
    } finally {
      watcher.restore();
    }
  });

  it("detects property writes through stored() length checks", () => {
    const watcher = watchStorage();
    try {
      expect(stored()).toEqual({ local: 0, session: 0 });

      (localStorage as unknown as Record<string, string>)["directProp"] = "bypassed-set-item";

      const lengths = stored();
      expect(lengths.local).toBeGreaterThan(0);
      expect(lengths.session).toBe(0);
      expect(localStorage.length).toBeGreaterThan(0);
    } finally {
      delete (localStorage as unknown as Record<string, string>)["directProp"];
      watcher.restore();
    }
  });
});
