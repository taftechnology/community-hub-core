export const stub = defineModule({
  key: "audit",
  version: 1,
  requires: [],
  publishes: [],
  subscribes: [],
  ports: [],
});

export const action = defineAuditAction("audit.chain.recorded");
export const purpose = defineAuditPurpose("audit.chain.recorded");

declare function defineModule(def: {
  key: string;
  version: number;
  requires: string[];
  publishes: string[];
  subscribes: string[];
  ports: string[];
}): unknown;
declare function defineAuditAction(name: string): string;
declare function defineAuditPurpose(name: string): string;
