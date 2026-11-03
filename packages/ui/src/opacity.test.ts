// @vitest-environment node
import { describe, expect, it } from "vitest";
import { opacityViolations, opacityViolationsInSrc } from "./opacity";

describe("opacity violations check (Pin 13)", () => {
  it("rejects a focus ring opacity modifier", () => {
    expect(opacityViolations("focus-visible:ring-ring/50")).toEqual(["focus-visible:ring-ring/50"]);
  });

  it("rejects hover opacity", () => {
    expect(opacityViolations("hover:bg-primary/80")).toEqual(["hover:bg-primary/80"]);
  });

  it("rejects dark background opacity", () => {
    expect(opacityViolations("dark:bg-input/30")).toEqual(["dark:bg-input/30"]);
  });

  it("rejects bracketed opacity modifier", () => {
    expect(opacityViolations("border-border/[0.5]")).toEqual(["border-border/[0.5]"]);
  });

  it("allows non-opacity utilities and fractions", () => {
    expect(opacityViolations("w-1/2 max-w-1/2 aspect-16/9 h-(--ch-size-control)")).toEqual([]);
    expect(opacityViolations("bg-primary text-foreground border-field-border")).toEqual([]);
  });

  it("finds no opacity violations in any source file in packages/ui/src", () => {
    expect(opacityViolationsInSrc(new URL(".", import.meta.url))).toEqual([]);
  });
});
