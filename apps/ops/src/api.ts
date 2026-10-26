export type ApiResult = { kind: "response"; status: number; body: unknown } | { kind: "network" };

export type ApiPostOptions = {
  keepalive?: boolean;
};

export type ApiClient = {
  get(path: string): Promise<ApiResult>;
  post(path: string, body?: unknown, options?: ApiPostOptions): Promise<ApiResult>;
};

function assertOpsPath(path: string): void {
  if (!path.startsWith("/v1/ops/")) {
    throw new Error(`Expected relative path starting with /v1/ops/, got: ${path}`);
  }
}

export function createApi(fetchFn: typeof fetch): ApiClient {
  return {
    get(path: string): Promise<ApiResult> {
      assertOpsPath(path);
      return (async () => {
        try {
          const res = await fetchFn(path);
          let body: unknown = undefined;
          const text = await res.text();
          if (text.length > 0) {
            try {
              body = JSON.parse(text);
            } catch {
              body = undefined;
            }
          }
          return { kind: "response", status: res.status, body };
        } catch {
          return { kind: "network" };
        }
      })();
    },

    post(path: string, body: unknown = {}, options?: ApiPostOptions): Promise<ApiResult> {
      assertOpsPath(path);
      const init: RequestInit = {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body ?? {}),
      };
      if (options?.keepalive !== undefined) {
        init.keepalive = options.keepalive;
      }
      return (async () => {
        try {
          const res = await fetchFn(path, init);
          let parsedBody: unknown = undefined;
          const text = await res.text();
          if (text.length > 0) {
            try {
              parsedBody = JSON.parse(text);
            } catch {
              parsedBody = undefined;
            }
          }
          return { kind: "response", status: res.status, body: parsedBody };
        } catch {
          return { kind: "network" };
        }
      })();
    },
  };
}

export function isGenericFailure(result: ApiResult): boolean {
  if (result.kind === "network") {
    return true;
  }
  return (
    result.status === 403 || result.status === 429 || (result.status >= 500 && result.status <= 599)
  );
}
