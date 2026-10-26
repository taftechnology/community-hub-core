import type { ApiClient, ApiResult } from "./api.js";
import type { LockLike } from "./deps.js";

export type SessionResult = ApiResult | { kind: "ended" };

export type SessionClient = {
  authedGet(path: string): Promise<SessionResult>;
  signOut(): Promise<ApiResult>;
};

export type SessionClientOptions = {
  api: ApiClient;
  locks: LockLike;
};

export function createSessionClient({ api, locks }: SessionClientOptions): SessionClient {
  return {
    async authedGet(path: string): Promise<SessionResult> {
      const initial = await api.get(path);
      if (initial.kind !== "response" || initial.status !== 401) {
        return initial;
      }

      return await locks.request("ops-session-refresh", async () => {
        // 1. Repeat the get. If it is not a 401, return it.
        const repeated = await api.get(path);
        if (repeated.kind !== "response" || repeated.status !== 401) {
          return repeated;
        }

        // 2. Otherwise post("/v1/ops/session/refresh", {}, { keepalive: true }).
        const refreshRes = await api.post("/v1/ops/session/refresh", {}, { keepalive: true });

        // 3. On 200, repeat the get once more and return it (or ended if 401).
        if (refreshRes.kind === "response" && refreshRes.status === 200) {
          const finalGet = await api.get(path);
          if (finalGet.kind === "response" && finalGet.status === 401) {
            return { kind: "ended" };
          }
          return finalGet;
        }

        // 4. On 401, return { kind: "ended" }.
        if (refreshRes.kind === "response" && refreshRes.status === 401) {
          return { kind: "ended" };
        }

        // 5. Any other refresh outcome is returned as is.
        return refreshRes;
      });
    },

    async signOut(): Promise<ApiResult> {
      return await locks.request("ops-session-refresh", async () => {
        return await api.post("/v1/ops/session/end");
      });
    },
  };
}
