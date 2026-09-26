export const stub = defineModule({
  key: "audit",
  version: 1,
  requires: [],
  publishes: [],
  subscribes: [],
  ports: [],
});

export const bad = defineAuditAction("people.person.read.v1");

declare function defineModule(def: {
  key: string;
  version: number;
  requires: string[];
  publishes: string[];
  subscribes: string[];
  ports: string[];
}): unknown;
declare function defineAuditAction(name: string): string;
