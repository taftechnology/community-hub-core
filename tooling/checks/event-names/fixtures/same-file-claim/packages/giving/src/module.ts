export const recorded = defineEvent({
  name: "giving.donation.recorded.v1",
  payload: {},
});

export const giving = defineModule({
  key: "giving",
  version: 1,
  requires: [],
  publishes: ["giving.donation.recorded.v1"],
  subscribes: [],
  ports: [],
});

declare function defineEvent(spec: { name: string; payload: unknown }): unknown;
declare function defineModule(def: {
  key: string;
  version: number;
  requires: string[];
  publishes: string[];
  subscribes: string[];
  ports: string[];
}): unknown;
