import { describe, expect, it } from "vitest";
import { terminology, type TerminologyKey } from "./terminology.js";

describe("faith-church terminology", () => {
  it("returns Mass Times terminology for engagement.service_times", () => {
    const key: TerminologyKey = "engagement.service_times";
    const term = terminology(key);

    expect(term.singular).toBe("Mass Time");
    expect(term.plural).toBe("Mass Times");
    expect(term.fieldLabel).toBe("Schedule Content");

    expect(typeof term.placeholder).toBe("string");
    expect(term.placeholder.trim().length).toBeGreaterThan(0);

    expect(typeof term.hint).toBe("string");
    expect(term.hint.trim().length).toBeGreaterThan(0);
    expect(term.hint).toContain("appears on your public website and in the Parish Hub app");
    expect(term.hint).toContain("Numbered lists always start at 1");
    expect(term.hint).not.toMatch(/\b(center|color|favor|honor)\b/i);
  });

  it("returns a frozen object so callers cannot mutate the pack", () => {
    const term = terminology("engagement.service_times");
    expect(Object.isFrozen(term)).toBe(true);

    expect(() => {
      // @ts-expect-error mutating readonly property on frozen object
      term.singular = "Other";
    }).toThrow();
  });

  it("throws a plain Error for an unknown key", () => {
    expect(() => terminology("unknown.key" as unknown as TerminologyKey)).toThrow(Error);
  });
});
