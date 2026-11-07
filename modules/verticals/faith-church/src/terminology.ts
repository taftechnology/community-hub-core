export type TerminologyKey = "engagement.service_times";

export interface Terminology {
  readonly singular: string;
  readonly plural: string;
  readonly fieldLabel: string;
  readonly placeholder: string;
  readonly hint: string;
}

const TERMINOLOGY_MAP: Readonly<Record<TerminologyKey, Terminology>> = Object.freeze({
  "engagement.service_times": Object.freeze({
    singular: "Mass Time",
    plural: "Mass Times",
    fieldLabel: "Schedule Content",
    placeholder: "Enter Mass and service times here...",
    hint: "This appears on your public website and in the Parish Hub app. Numbered lists always start at 1.",
  }),
});

export function terminology(key: TerminologyKey): Terminology {
  const item = TERMINOLOGY_MAP[key];
  if (!item) {
    throw new Error(`Unknown terminology key: ${String(key)}`);
  }
  return item;
}
