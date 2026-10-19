import type { BillingState } from "./state.js";

export class BillingReadOnly extends Error {
  readonly state: BillingState;

  constructor(state: BillingState) {
    super(`Organisation is read-only (billing state: ${state})`);
    this.name = "BillingReadOnly";
    this.state = state;
  }
}

export function isWritable(state: BillingState): boolean {
  return state !== "none" && state !== "read_only";
}
