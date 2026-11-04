import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ACCESS_TOKEN_KEY,
  clearSignOutHandle,
  readSignOutHandle,
  storeSignOutHandle,
} from "./directory";
import { defaultClear, signOut, type SignOutDeps } from "./sign-out";

const FAKE_HANDLE = "fake-" + "handle-1";
const FAKE_AUTH = "https://au.auth.example.test";
const FAKE_API = "https://au.api.example.test";
const SIGNOUT_HANDLE_KEY = "community-hub.signout-handle";
const COMMUNITY_SLUG_KEY = "community-hub.community";

describe("sign-out", () => {
  const navigatedUrls: string[] = [];

  beforeEach(() => {
    navigatedUrls.length = 0;
    sessionStorage.clear();
    sessionStorage.setItem(ACCESS_TOKEN_KEY, "fake-" + "access-token-1");
    sessionStorage.setItem(SIGNOUT_HANDLE_KEY, FAKE_HANDLE);
    sessionStorage.setItem(COMMUNITY_SLUG_KEY, "parish-slug");
    vi.stubEnv("VITE_API_ORIGIN", FAKE_API);
    vi.stubEnv("VITE_AUTH_ORIGIN", FAKE_AUTH);
  });

  afterEach(() => {
    sessionStorage.clear();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  function recordNavigate(url: string) {
    navigatedUrls.push(url);
  }

  it("handles directory storage helpers with try/catch and storage errors", () => {
    storeSignOutHandle(FAKE_HANDLE);
    expect(readSignOutHandle()).toBe(FAKE_HANDLE);
    clearSignOutHandle();
    expect(readSignOutHandle()).toBeNull();

    // When storage throws, read returns null, store and clear do not throw
    const originalStorage = window.sessionStorage;
    const throwingStorage: Storage = {
      getItem: () => {
        throw new Error("storage quota / disabled");
      },
      setItem: () => {
        throw new Error("storage quota / disabled");
      },
      removeItem: () => {
        throw new Error("storage quota / disabled");
      },
      clear: () => {},
      key: () => null,
      length: 0,
    };

    vi.stubGlobal("sessionStorage", throwingStorage);
    try {
      expect(() => storeSignOutHandle("another-handle")).not.toThrow();
      expect(readSignOutHandle()).toBeNull();
      expect(() => clearSignOutHandle()).not.toThrow();
    } finally {
      vi.stubGlobal("sessionStorage", originalStorage);
    }
  });

  const outcomeCases = [
    { name: "204 response", status: 204, expectedUrl: "/sign-in", throws: false },
    { name: "401 response", status: 401, expectedUrl: "/sign-in", throws: false },
    {
      name: "400 response",
      status: 400,
      expectedUrl: "/sign-in?signout=unconfirmed",
      throws: false,
    },
    {
      name: "404 response",
      status: 404,
      expectedUrl: "/sign-in?signout=unconfirmed",
      throws: false,
    },
    {
      name: "500 response",
      status: 500,
      expectedUrl: "/sign-in?signout=unconfirmed",
      throws: false,
    },
    { name: "fetch throws", status: 0, expectedUrl: "/sign-in?signout=unconfirmed", throws: true },
  ];

  for (const tc of outcomeCases) {
    it(`navigates to ${tc.expectedUrl} on ${tc.name}`, async () => {
      const fetchSpy = vi.fn<typeof globalThis.fetch>(async () => {
        if (tc.throws) {
          throw new Error("network disconnect");
        }
        return {
          status: tc.status,
          headers: new Headers(),
          get json() {
            throw new Error("response body must never be read");
          },
          get text() {
            throw new Error("response body must never be read");
          },
        } as unknown as Response;
      });

      await signOut({
        fetch: fetchSpy,
        navigate: recordNavigate,
      });

      expect(fetchSpy).toHaveBeenCalledOnce();
      const [url, init] = fetchSpy.mock.calls[0] ?? [];
      expect(url).toBe(`${FAKE_AUTH}/v1/auth/session/end`);
      expect(init?.method).toBe("POST");
      expect(init?.cache).toBe("no-store");
      expect(init?.body).toBe("{}");
      const headers = new Headers(init?.headers);
      expect(headers.get("content-type")).toBe("application/json");
      expect(headers.get("authorization")).toBe(`Bearer ${FAKE_HANDLE}`);

      expect(navigatedUrls).toEqual([tc.expectedUrl]);
      // All local session state cleared
      expect(sessionStorage.getItem(ACCESS_TOKEN_KEY)).toBeNull();
      expect(sessionStorage.getItem(SIGNOUT_HANDLE_KEY)).toBeNull();
      expect(sessionStorage.getItem(COMMUNITY_SLUG_KEY)).toBeNull();
    });
  }

  it("navigates to /sign-in?signout=unconfirmed when origins is undefined, with no fetch", async () => {
    const fetchSpy = vi.fn<typeof globalThis.fetch>();
    await signOut({
      origins: undefined,
      fetch: fetchSpy,
      navigate: recordNavigate,
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(navigatedUrls).toEqual(["/sign-in?signout=unconfirmed"]);
    expect(sessionStorage.getItem(ACCESS_TOKEN_KEY)).toBeNull();
    expect(sessionStorage.getItem(SIGNOUT_HANDLE_KEY)).toBeNull();
    expect(sessionStorage.getItem(COMMUNITY_SLUG_KEY)).toBeNull();
  });

  it("navigates to /sign-in when handle is null, with no fetch", async () => {
    const fetchSpy = vi.fn<typeof globalThis.fetch>();
    await signOut({
      readHandle: () => null,
      fetch: fetchSpy,
      navigate: recordNavigate,
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(navigatedUrls).toEqual(["/sign-in"]);
    expect(sessionStorage.getItem(ACCESS_TOKEN_KEY)).toBeNull();
    expect(sessionStorage.getItem(SIGNOUT_HANDLE_KEY)).toBeNull();
    expect(sessionStorage.getItem(COMMUNITY_SLUG_KEY)).toBeNull();
  });

  it("Pin 10: clears access token, handle and slug even on 500 or thrown fetch", async () => {
    // 500 case
    sessionStorage.setItem(ACCESS_TOKEN_KEY, "token-500");
    sessionStorage.setItem(SIGNOUT_HANDLE_KEY, FAKE_HANDLE);
    sessionStorage.setItem(COMMUNITY_SLUG_KEY, "parish-500");

    await signOut({
      fetch: vi
        .fn()
        .mockResolvedValue({ status: 500 } as Response) as unknown as typeof globalThis.fetch,
      navigate: recordNavigate,
    });

    expect(sessionStorage.getItem(ACCESS_TOKEN_KEY)).toBeNull();
    expect(sessionStorage.getItem(SIGNOUT_HANDLE_KEY)).toBeNull();
    expect(sessionStorage.getItem(COMMUNITY_SLUG_KEY)).toBeNull();

    // Thrown fetch case
    sessionStorage.setItem(ACCESS_TOKEN_KEY, "token-thrown");
    sessionStorage.setItem(SIGNOUT_HANDLE_KEY, FAKE_HANDLE);
    sessionStorage.setItem(COMMUNITY_SLUG_KEY, "parish-thrown");

    await signOut({
      fetch: vi
        .fn()
        .mockRejectedValue(new Error("network failure")) as unknown as typeof globalThis.fetch,
      navigate: recordNavigate,
    });

    expect(sessionStorage.getItem(ACCESS_TOKEN_KEY)).toBeNull();
    expect(sessionStorage.getItem(SIGNOUT_HANDLE_KEY)).toBeNull();
    expect(sessionStorage.getItem(COMMUNITY_SLUG_KEY)).toBeNull();
  });

  it("Pin 11b: every navigate argument is exactly one of the two allowed URLs and none contains handle", async () => {
    const testCases: Partial<SignOutDeps>[] = [
      {
        fetch: vi
          .fn()
          .mockResolvedValue({ status: 204 } as Response) as unknown as typeof globalThis.fetch,
      },
      {
        fetch: vi
          .fn()
          .mockResolvedValue({ status: 401 } as Response) as unknown as typeof globalThis.fetch,
      },
      {
        fetch: vi
          .fn()
          .mockResolvedValue({ status: 400 } as Response) as unknown as typeof globalThis.fetch,
      },
      {
        fetch: vi
          .fn()
          .mockResolvedValue({ status: 404 } as Response) as unknown as typeof globalThis.fetch,
      },
      {
        fetch: vi
          .fn()
          .mockResolvedValue({ status: 500 } as Response) as unknown as typeof globalThis.fetch,
      },
      { fetch: vi.fn().mockRejectedValue(new Error("fail")) as unknown as typeof globalThis.fetch },
      { origins: undefined },
      { readHandle: () => null },
    ];

    const urls: string[] = [];
    for (const tc of testCases) {
      await signOut({
        ...tc,
        navigate: (url) => urls.push(url),
      });
    }

    expect(urls.length).toBe(testCases.length);
    for (const url of urls) {
      expect(["/sign-in", "/sign-in?signout=unconfirmed"]).toContain(url);
      expect(url).not.toContain(FAKE_HANDLE);
      expect(url).not.toContain("fake-");
    }
  });

  it("defaultClear survives when sessionStorage throws without throwing", () => {
    const originalRemove = sessionStorage.removeItem;
    try {
      sessionStorage.removeItem = () => {
        throw new Error("storage failed");
      };
      expect(() => defaultClear()).not.toThrow();
    } finally {
      sessionStorage.removeItem = originalRemove;
    }
  });
});
