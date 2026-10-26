import { createElement } from "react";
import { render, type RenderResult } from "@testing-library/react";
import { vi } from "vitest";

import type { LockLike, OpsDeps } from "./deps.js";
import { Shell } from "./shell.js";

export type StubCall = {
  method: string;
  url: string;
  path: string;
  headers: Headers;
  rawBody: string | null;
  body: unknown;
};

export type StubResponseValue =
  | Response
  | {
      status?: number;
      body?: unknown;
      headers?: Record<string, string>;
    };

export type StubResponseHandler =
  StubResponseValue | ((req: Request) => Response | Promise<Response>);

export type StubRoutes = Record<string, StubResponseHandler | StubResponseHandler[]>;

export function fakeLocks(): LockLike {
  const queues = new Map<string, Promise<unknown>>();
  return {
    async request<T>(name: string, callback: () => Promise<T>): Promise<T> {
      const prev = queues.get(name) ?? Promise.resolve();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      queues.set(
        name,
        prev.then(
          () => gate,
          () => gate,
        ),
      );
      await prev;
      try {
        return await callback();
      } finally {
        release();
      }
    },
  };
}

export type StorageCall =
  | { type: "local"; key: string; value: string }
  | { type: "session"; key: string; value: string }
  | { type: "cookie"; value: string };

export type StorageWatcher = StorageCall[] & {
  calls: StorageCall[];
  restore: () => void;
};

export function watchStorage(): StorageWatcher {
  const calls = [] as unknown as StorageWatcher;
  Object.defineProperty(calls, "calls", { value: calls, enumerable: false });

  const winLocal = typeof window !== "undefined" ? window.localStorage : undefined;
  const winSession = typeof window !== "undefined" ? window.sessionStorage : undefined;

  const storageProto =
    winSession !== undefined
      ? Object.getPrototypeOf(winSession)
      : typeof Storage !== "undefined"
        ? Storage.prototype
        : undefined;

  const localSpy = storageProto
    ? vi.spyOn(storageProto as Storage, "setItem").mockImplementation(function (
        this: Storage,
        key: string,
        value: string,
      ) {
        if (winLocal && this === winLocal) {
          calls.push({ type: "local", key, value: String(value) });
        } else {
          calls.push({ type: "session", key, value: String(value) });
        }
      })
    : undefined;

  const cookieDesc =
    (typeof Document !== "undefined" &&
      Object.getOwnPropertyDescriptor(Document.prototype, "cookie")) ||
    (typeof HTMLDocument !== "undefined" &&
      Object.getOwnPropertyDescriptor(HTMLDocument.prototype, "cookie"));

  let cookieSpy: ReturnType<typeof vi.spyOn> | undefined;
  if (cookieDesc && cookieDesc.set) {
    const origSet = cookieDesc.set;
    cookieSpy = vi.spyOn(document, "cookie", "set").mockImplementation(function (value: string) {
      calls.push({ type: "cookie", value: String(value) });
      origSet.call(document, value);
    });
  }

  calls.restore = () => {
    localSpy?.mockRestore();
    cookieSpy?.mockRestore();
  };

  return calls;
}

export type StubCredentials = Pick<CredentialsContainer, "get" | "create"> & {
  get: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
};

export function createStubCredentials(): StubCredentials {
  return {
    get: vi.fn().mockResolvedValue({
      id: "cred-1",
      rawId: new Uint8Array([1, 2, 3]).buffer,
      response: {
        clientDataJSON: new Uint8Array([]).buffer,
        authenticatorData: new Uint8Array([]).buffer,
        signature: new Uint8Array([]).buffer,
      },
    }),
    create: vi.fn().mockResolvedValue({
      id: "cred-1",
      rawId: new Uint8Array([1, 2, 3]).buffer,
      response: {
        clientDataJSON: new Uint8Array([]).buffer,
        attestationObject: new Uint8Array([]).buffer,
      },
    }),
  };
}

export type StubbedOpsDeps = OpsDeps & {
  calls: StubCall[];
  credentials: StubCredentials;
  locks: LockLike;
};

function formatStubResponse(res: StubResponseValue): Response {
  if (res instanceof Response) {
    return res;
  }
  const status = res.status ?? 200;
  const headers = new Headers(res.headers);
  let bodyStr: string | null = null;
  if (res.body !== undefined) {
    if (typeof res.body === "string") {
      bodyStr = res.body;
    } else {
      bodyStr = JSON.stringify(res.body);
      if (!headers.has("content-type")) {
        headers.set("content-type", "application/json");
      }
    }
  }
  return new Response(bodyStr, { status, headers });
}

export function stubDeps(routes: StubRoutes = {}, overrides?: Partial<OpsDeps>): StubbedOpsDeps {
  const calls: StubCall[] = [];
  const routeState: Record<string, StubResponseHandler[]> = {};

  for (const [key, val] of Object.entries(routes)) {
    routeState[key] = Array.isArray(val) ? [...val] : [val];
  }

  const stubFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    let urlStr: string;
    let method: string;
    let headers: Headers;
    let rawBody: string | null = null;

    if (input instanceof Request) {
      urlStr = input.url;
      method = init?.method ?? input.method;
      headers = new Headers(input.headers);
      if (init?.headers) {
        new Headers(init.headers).forEach((v, k) => headers.set(k, v));
      }
      if (init?.body !== undefined) {
        rawBody = typeof init.body === "string" ? init.body : String(init.body);
      }
    } else {
      urlStr = typeof input === "string" ? input : input.toString();
      method = init?.method ?? "GET";
      headers = new Headers(init?.headers);
      if (init?.body !== undefined && init?.body !== null) {
        rawBody = typeof init.body === "string" ? init.body : String(init.body);
      }
    }

    const path = urlStr.startsWith("/")
      ? urlStr.split("?")[0]!
      : new URL(urlStr, "https://ops.example.test").pathname;

    let parsedBody: unknown = undefined;
    if (rawBody !== null) {
      try {
        parsedBody = JSON.parse(rawBody);
      } catch {
        parsedBody = rawBody;
      }
    }

    calls.push({
      method: method.toUpperCase(),
      url: urlStr,
      path,
      headers,
      rawBody,
      body: parsedBody,
    });

    const methodKey = `${method.toUpperCase()} ${path}`;
    const matchedKey = methodKey in routeState ? methodKey : path in routeState ? path : undefined;

    if (matchedKey && routeState[matchedKey] && routeState[matchedKey]!.length > 0) {
      const handler =
        routeState[matchedKey]!.length === 1
          ? routeState[matchedKey]![0]!
          : routeState[matchedKey]!.shift()!;

      if (typeof handler === "function") {
        const req =
          input instanceof Request
            ? input
            : new Request(
                urlStr.startsWith("/") ? `https://ops.example.test${urlStr}` : urlStr,
                init,
              );
        return await handler(req);
      }
      return formatStubResponse(handler);
    }

    return new Response(null, { status: 404 });
  };

  const credentials = createStubCredentials();
  const locks = fakeLocks();

  return {
    fetch: stubFetch as typeof fetch,
    credentials,
    locks,
    publicKeyCredentialSupported: true,
    calls,
    ...overrides,
  } as StubbedOpsDeps;
}

export function renderAt(hash: string, deps: OpsDeps): RenderResult {
  const targetHash = hash.startsWith("#") ? hash : `#${hash}`;
  history.replaceState(null, "", targetHash);
  return render(createElement(Shell, { deps }));
}
