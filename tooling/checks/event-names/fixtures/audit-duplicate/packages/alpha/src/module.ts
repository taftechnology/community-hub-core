export const alpha = defineModule({
  key: "alpha",
  version: 1,
  requires: [],
  publishes: [],
  subscribes: [],
  ports: [],
});

export const action = defineAuditAction("audit.chain.recorded");

declare function defineModule(def: {
  key: string;
  version: number;
  requires: string[];
  publishes: string[];
  subscribes: string[];
  ports: string[];
}): unknown;
declare function defineAuditAction(name: string): string;
