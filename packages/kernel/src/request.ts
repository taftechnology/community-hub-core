import { AsyncLocalStorage } from "node:async_hooks";

export type RequestContext = { requestId: string; idempotencyKey: string };

const storage = new AsyncLocalStorage<RequestContext>();

export function withRequest<T>(ctx: RequestContext, fn: () => Promise<T>): Promise<T> {
  return storage.run(ctx, fn);
}

export function getRequestContext(): RequestContext {
  const ctx = storage.getStore();
  if (!ctx) {
    throw new Error("Request context is missing");
  }
  return ctx;
}
