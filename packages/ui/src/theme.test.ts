import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyTheme, initialTheme, readStoredTheme, systemTheme, THEME_STORAGE_KEY } from "./theme";

function createStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, val: string) => {
      store.set(key, String(val));
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() {
      return store.size;
    },
  };
}

describe("theme module", () => {
  let storage: Storage;

  beforeEach(() => {
    storage = createStorage();
    vi.stubGlobal("localStorage", storage);
    delete document.documentElement.dataset.theme;
  });

  afterEach(() => {
    delete document.documentElement.dataset.theme;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("exports the expected storage key", () => {
    expect(THEME_STORAGE_KEY).toBe("community-hub.theme");
  });

  it("initialTheme() returns the stored value when one is stored", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "dark");
    expect(initialTheme()).toBe("dark");

    localStorage.setItem(THEME_STORAGE_KEY, "light");
    expect(initialTheme()).toBe("light");
  });

  it("initialTheme() returns matchMedia result when nothing is stored", () => {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query.includes("dark"),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    expect(initialTheme()).toBe("dark");

    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    expect(initialTheme()).toBe("light");
  });

  it("with nothing stored, data-theme stays unset", () => {
    expect(document.documentElement.dataset.theme).toBeUndefined();
    initialTheme();
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it("applyTheme('dark') sets data-theme='dark' and stores 'dark'", () => {
    applyTheme("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
  });

  it("survives localStorage.setItem and getItem throwing", () => {
    vi.spyOn(storage, "getItem").mockImplementation(() => {
      throw new Error("Storage disabled");
    });
    vi.spyOn(storage, "setItem").mockImplementation(() => {
      throw new Error("Quota exceeded");
    });

    expect(() => applyTheme("dark")).not.toThrow();
    expect(document.documentElement.dataset.theme).toBe("dark");

    expect(() => readStoredTheme()).not.toThrow();
    expect(readStoredTheme()).toBeNull();
  });

  it("returns null on an unknown stored value ('blue')", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "blue");
    expect(readStoredTheme()).toBeNull();
  });

  it("systemTheme() falls back to light if matchMedia is missing", () => {
    const originalMatchMedia = window.matchMedia;
    // @ts-expect-error testing missing matchMedia
    delete window.matchMedia;
    expect(systemTheme()).toBe("light");
    window.matchMedia = originalMatchMedia;
  });
});
