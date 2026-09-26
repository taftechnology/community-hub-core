const name = "audit.chain.recorded";

export const stub = defineModule({
  key: "audit",
  version: 1,
  requires: [],
  publishes: [],
  subscribes: [],
  ports: [],
});

export const bad = defineAuditAction(name);

declare function defineModule(def: {
  key: string;
  version: number;
  requires: string[];
  publishes: string[];
  subscribes: string[];
  ports: string[];
}): unknown;
declare function defineAuditAction(name: string): string;
