import { AsyncLocalStorage } from "node:async_hooks";

export type RequestContext = {
  requestId: string;
  clientIdempotencyKey?: string;
  idempotencyKey?: string;
};

const storage = new AsyncLocalStorage<RequestContext>();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VERSION = /^(0|[1-9][0-9]*)$/;

export function withRequest<T>(
  ctx: { requestId: string; clientIdempotencyKey?: string },
  fn: () => Promise<T>,
): Promise<T> {
  const store: RequestContext = { requestId: ctx.requestId };
  if (ctx.clientIdempotencyKey !== undefined) {
    store.clientIdempotencyKey = ctx.clientIdempotencyKey;
  }
  return storage.run(store, fn);
}

export function withChangeKey<T>(
  aggregateId: string,
  version: string,
  fn: () => Promise<T>,
): Promise<T> {
  const outer = getRequestContext();
  if (!UUID.test(aggregateId)) {
    throw new Error("aggregateId must be a UUID");
  }
  if (!VERSION.test(version)) {
    throw new Error("version must be a non-negative integer");
  }
  const id = aggregateId.toLowerCase();
  const idempotencyKey = outer.clientIdempotencyKey
    ? `client:${outer.clientIdempotencyKey}:${id}:${version}`
    : `change:${id}:${version}`;
  const next: RequestContext = {
    requestId: outer.requestId,
    idempotencyKey,
  };
  if (outer.clientIdempotencyKey !== undefined) {
    next.clientIdempotencyKey = outer.clientIdempotencyKey;
  }
  return storage.run(next, fn);
}

export function getRequestContext(): RequestContext {
  const ctx = storage.getStore();
  if (!ctx) {
    throw new Error("Request context is missing");
  }
  return ctx;
}
