import type { z } from "zod";

export const EVENT_NAME_RE = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.v[1-9][0-9]*$/;

export type DefinedEvent<S extends z.ZodTypeAny = z.ZodTypeAny> = {
  name: string;
  payload: S;
};

export function defineEvent<S extends z.ZodTypeAny>(spec: {
  name: string;
  payload: S;
}): DefinedEvent<S> {
  if (!EVENT_NAME_RE.test(spec.name)) {
    throw new Error(`Invalid event name: ${spec.name}`);
  }
  return spec;
}
