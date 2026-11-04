import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NARROW_VIEWPORT_QUERY, useNarrowViewport } from "./use-narrow-viewport";

describe("useNarrowViewport", () => {
  const originalMatchMedia = window.matchMedia;

  afterEach(() => {
    window.matchMedia = originalMatchMedia;
    vi.restoreAllMocks();
  });

  it("returns false when matchMedia is missing", () => {
    // @ts-expect-error testing missing matchMedia
    delete window.matchMedia;
    const { result } = renderHook(() => useNarrowViewport());
    expect(result.current).toBe(false);
  });

  it("returns false when matchMedia throws", () => {
    window.matchMedia = vi.fn().mockImplementation(() => {
      throw new Error("unsupported");
    });
    const { result } = renderHook(() => useNarrowViewport());
    expect(result.current).toBe(false);
  });

  it("returns initial match state when matchMedia matches", () => {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: true,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));

    const { result } = renderHook(() => useNarrowViewport());
    expect(window.matchMedia).toHaveBeenCalledWith(NARROW_VIEWPORT_QUERY);
    expect(result.current).toBe(true);
  });

  it("returns initial match state when matchMedia does not match", () => {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));

    const { result } = renderHook(() => useNarrowViewport());
    expect(result.current).toBe(false);
  });

  it("updates when change event fires via addEventListener and cleans up on unmount", () => {
    const listeners = new Set<(e: Event) => void>();
    const removeEventListener = vi.fn((type: string, cb: (e: Event) => void) => {
      if (type === "change") listeners.delete(cb);
    });

    const mql = {
      matches: false,
      media: NARROW_VIEWPORT_QUERY,
      addEventListener: vi.fn((type: string, cb: (e: Event) => void) => {
        if (type === "change") listeners.add(cb);
      }),
      removeEventListener,
    };
    window.matchMedia = vi.fn().mockReturnValue(mql);

    const { result, unmount } = renderHook(() => useNarrowViewport());
    expect(result.current).toBe(false);

    // Fire event with matches: true
    act(() => {
      mql.matches = true;
      const event = new Event("change");
      Object.assign(event, { matches: true });
      listeners.forEach((cb) => cb(event));
    });
    expect(result.current).toBe(true);

    // Fire event with matches: false
    act(() => {
      mql.matches = false;
      const event = new Event("change");
      Object.assign(event, { matches: false });
      listeners.forEach((cb) => cb(event));
    });
    expect(result.current).toBe(false);

    unmount();
    expect(removeEventListener).toHaveBeenCalled();
    expect(listeners.size).toBe(0);
  });

  it("supports legacy addListener and removeListener fallback", () => {
    const listeners = new Set<(e: Event) => void>();
    const removeListener = vi.fn((cb: (e: Event) => void) => {
      listeners.delete(cb);
    });

    const mql = {
      matches: false,
      media: NARROW_VIEWPORT_QUERY,
      addListener: vi.fn((cb: (e: Event) => void) => listeners.add(cb)),
      removeListener,
    };
    window.matchMedia = vi.fn().mockReturnValue(mql);

    const { result, unmount } = renderHook(() => useNarrowViewport());
    expect(result.current).toBe(false);

    act(() => {
      mql.matches = true;
      listeners.forEach((cb) => cb(new Event("change")));
    });
    expect(result.current).toBe(true);

    unmount();
    expect(removeListener).toHaveBeenCalled();
  });
});
