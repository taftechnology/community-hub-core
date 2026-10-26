import { describe, expect, it, vi } from "vitest";

import { createApi } from "./api.js";
import { createSessionClient } from "./session.js";
import { fakeLocks, watchStorage } from "./test-support.js";

function createDeferred<T = void>() {
  let resolve!: (val: T | PromiseLike<T>) => void;
  let reject!: (err?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type CookieJarOptions = {
  initialJarCounter?: number;
  initialValidCounter?: number;
  forceRefreshStatus?: number;
  forceFinalGetStatus?: number;
  forceSignOutStatus?: number;
  rotateOnRepeat?: boolean;
};

function createCookieJar(opts: CookieJarOptions = {}) {
  let jarCounter = opts.initialJarCounter ?? 0;
  let validCounter = opts.initialValidCounter ?? 1;
  let activeRefreshes = 0;
  let maxRefreshesInFlight = 0;
  let refreshCalls = 0;
  let getCalls = 0;
  let signOutCalls = 0;
  let lastRefreshKeepalive: boolean | undefined = undefined;
  const deferred = createDeferred();

  const fetchFn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();

    if (method === "GET") {
      getCalls++;
      if (opts.rotateOnRepeat && getCalls === 2) {
        // Model another tab having rotated the cookie right before our repeat GET
        jarCounter = validCounter;
      }
      if (opts.forceFinalGetStatus && getCalls >= 3) {
        return new Response(JSON.stringify({ error: "final get failed" }), {
          status: opts.forceFinalGetStatus,
          headers: { "content-type": "application/json" },
        });
      }
      if (jarCounter === validCounter) {
        return new Response(JSON.stringify({ counter: jarCounter }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }

    if (method === "POST" && url === "/v1/ops/session/refresh") {
      refreshCalls++;
      activeRefreshes++;
      if (activeRefreshes > maxRefreshesInFlight) {
        maxRefreshesInFlight = activeRefreshes;
      }
      lastRefreshKeepalive = init?.keepalive;

      if (opts.forceRefreshStatus) {
        activeRefreshes--;
        return new Response(JSON.stringify({ error: "refresh failed" }), {
          status: opts.forceRefreshStatus,
          headers: { "content-type": "application/json" },
        });
      }

      await deferred.promise;
      jarCounter = validCounter;
      activeRefreshes--;

      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (method === "POST" && url === "/v1/ops/session/end") {
      signOutCalls++;
      const status = opts.forceSignOutStatus ?? 204;
      return new Response(status === 204 ? null : JSON.stringify({ error: "unauthorized" }), {
        status,
        headers: status === 204 ? {} : { "content-type": "application/json" },
      });
    }

    return new Response(null, { status: 404 });
  };

  return {
    fetchFn: fetchFn as typeof fetch,
    releaseDeferred: () => deferred.resolve(),
    get jarCounter() {
      return jarCounter;
    },
    set jarCounter(v: number) {
      jarCounter = v;
    },
    get validCounter() {
      return validCounter;
    },
    set validCounter(v: number) {
      validCounter = v;
    },
    get activeRefreshes() {
      return activeRefreshes;
    },
    get maxRefreshesInFlight() {
      return maxRefreshesInFlight;
    },
    get refreshCalls() {
      return refreshCalls;
    },
    get getCalls() {
      return getCalls;
    },
    get signOutCalls() {
      return signOutCalls;
    },
    get lastRefreshKeepalive() {
      return lastRefreshKeepalive;
    },
  };
}

describe("session", () => {
  it("two 401s in one tab and in two tabs refresh one at a time (Pin 6a)", async () => {
    // Case 1: Two authedGet calls in one client
    const jar1 = createCookieJar();
    const locks1 = fakeLocks();
    const api1 = createApi(jar1.fetchFn);
    const client1 = createSessionClient({ api: api1, locks: locks1 });

    const p1 = client1.authedGet("/v1/ops/me");
    const p2 = client1.authedGet("/v1/ops/me");

    // Allow microtasks to run so requests reach the lock / refresh gate
    await new Promise((r) => setTimeout(r, 10));
    jar1.releaseDeferred();

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toEqual({ kind: "response", status: 200, body: { counter: 1 } });
    expect(r2).toEqual({ kind: "response", status: 200, body: { counter: 1 } });
    expect(jar1.maxRefreshesInFlight).toBe(1);

    // Case 2: One call in each of two clients sharing one fakeLocks()
    const jar2 = createCookieJar();
    const sharedLocks = fakeLocks();
    const clientA = createSessionClient({ api: createApi(jar2.fetchFn), locks: sharedLocks });
    const clientB = createSessionClient({ api: createApi(jar2.fetchFn), locks: sharedLocks });

    const pA = clientA.authedGet("/v1/ops/me");
    const pB = clientB.authedGet("/v1/ops/me");

    await new Promise((r) => setTimeout(r, 10));
    jar2.releaseDeferred();

    const [rA, rB] = await Promise.all([pA, pB]);
    expect(rA).toEqual({ kind: "response", status: 200, body: { counter: 1 } });
    expect(rB).toEqual({ kind: "response", status: 200, body: { counter: 1 } });
    expect(jar2.maxRefreshesInFlight).toBe(1);
  });

  it("repeats once before refreshing (Pin 6b)", async () => {
    // When the first repeat answers 200, no refresh is sent. At most three gets are made.
    const jar = createCookieJar({ rotateOnRepeat: true });
    jar.releaseDeferred();
    const locks = fakeLocks();
    const client = createSessionClient({ api: createApi(jar.fetchFn), locks });

    const res = await client.authedGet("/v1/ops/directory");
    expect(res).toEqual({ kind: "response", status: 200, body: { counter: 1 } });
    expect(jar.refreshCalls).toBe(0);
    expect(jar.getCalls).toBe(2); // initial get (401) + repeat get (200)
  });

  it("at most three gets are made per authedGet", async () => {
    // Initial get (401) + repeat before refresh (401) + repeat after refresh (200) = 3 gets
    const jar = createCookieJar();
    jar.releaseDeferred();
    const locks = fakeLocks();
    const client = createSessionClient({ api: createApi(jar.fetchFn), locks });

    const res = await client.authedGet("/v1/ops/me");
    expect(res).toEqual({ kind: "response", status: 200, body: { counter: 1 } });
    expect(jar.getCalls).toBe(3);
    expect(jar.refreshCalls).toBe(1);
  });

  it("refresh carries keepalive: true (U7)", async () => {
    const jar = createCookieJar();
    jar.releaseDeferred();
    const locks = fakeLocks();
    const client = createSessionClient({ api: createApi(jar.fetchFn), locks });

    await client.authedGet("/v1/ops/me");
    expect(jar.lastRefreshKeepalive).toBe(true);
  });

  it("refresh 401 gives ended, and 401 on final repeat gives ended", async () => {
    // Refresh answering 401 gives ended
    const jar1 = createCookieJar({ forceRefreshStatus: 401 });
    const client1 = createSessionClient({ api: createApi(jar1.fetchFn), locks: fakeLocks() });
    const res1 = await client1.authedGet("/v1/ops/me");
    expect(res1).toEqual({ kind: "ended" });

    // Final repeat get answering 401 gives ended
    const jar2 = createCookieJar({ forceFinalGetStatus: 401 });
    jar2.releaseDeferred();
    const client2 = createSessionClient({ api: createApi(jar2.fetchFn), locks: fakeLocks() });
    const res2 = await client2.authedGet("/v1/ops/me");
    expect(res2).toEqual({ kind: "ended" });
  });

  it("signOut answering 401 makes exactly one post and no refresh, and runs inside the lock (Pin 6)", async () => {
    const jar = createCookieJar({ forceSignOutStatus: 401 });
    const locks = fakeLocks();
    const lockSpy = vi.spyOn(locks, "request");
    const client = createSessionClient({ api: createApi(jar.fetchFn), locks });

    const res = await client.signOut();
    expect(res).toEqual({ kind: "response", status: 401, body: { error: "unauthorized" } });
    expect(lockSpy).toHaveBeenCalledWith("ops-session-refresh", expect.any(Function));
    expect(jar.signOutCalls).toBe(1);
    expect(jar.refreshCalls).toBe(0);
  });

  it("watchStorage() records nothing across session flows (Pin 5)", async () => {
    const watcher = watchStorage();
    const jar = createCookieJar();
    jar.releaseDeferred();
    const locks = fakeLocks();
    const client = createSessionClient({ api: createApi(jar.fetchFn), locks });

    await client.authedGet("/v1/ops/me");
    await client.signOut();

    expect(watcher.calls).toHaveLength(0);
    watcher.restore();
  });
});
