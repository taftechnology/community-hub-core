import { describe, expect, it } from "vitest";
import { buttonVariants } from "./button";

describe("Button classes and variants", () => {
  it("includes default control height, sm height, and touch media variant", () => {
    const defaultClasses = buttonVariants({ variant: "default", size: "default" });
    expect(defaultClasses).toContain("h-(--ch-size-control)");
    expect(defaultClasses).toContain("--ch-size-touch");

    const smClasses = buttonVariants({ size: "sm" });
    expect(smClasses).toContain("h-(--ch-size-control-sm)");
    expect(smClasses).toContain("--ch-size-touch");
  });

  it("includes 2px outline focus with 2px offset", () => {
    const defaultClasses = buttonVariants();
    expect(defaultClasses).toContain("focus-visible:outline-2");
    expect(defaultClasses).toContain("focus-visible:outline-offset-2");
    expect(defaultClasses).toContain("focus-visible:outline-ring");
  });

  it("includes solid fills for destructive variant and hover", () => {
    const destructiveClasses = buttonVariants({ variant: "destructive" });
    expect(destructiveClasses).toContain("bg-destructive");
    expect(destructiveClasses).toContain("hover:bg-destructive-hover");
    expect(destructiveClasses).toContain("text-destructive-foreground");
  });

  it("contains no opacity modifiers in any variant or size combination", () => {
    const variants = ["default", "outline", "secondary", "ghost", "destructive", "link"] as const;
    const sizes = ["default", "xs", "sm", "lg", "icon", "icon-xs", "icon-sm", "icon-lg"] as const;

    for (const variant of variants) {
      for (const size of sizes) {
        const classes = buttonVariants({ variant, size });
        // Must contain no / followed by digits or [...]
        expect(classes).not.toMatch(
          /(?:bg|ring|border|outline|text|fill)-[^\s"'`,]+\/(\d+|\[[^\]]+\])/,
        );
      }
    }
  });

  it("uses solid hovers for secondary, ghost and outline", () => {
    expect(buttonVariants({ variant: "secondary" })).toContain("hover:bg-secondary-hover");
    expect(buttonVariants({ variant: "ghost" })).toContain("hover:bg-secondary");
    const outlineClasses = buttonVariants({ variant: "outline" });
    expect(outlineClasses).toContain("bg-card");
    expect(outlineClasses).toContain("border-control-border");
    expect(outlineClasses).toContain("hover:border-control-border-hover");
  });

  it("has design disabled styling and cursor-not-allowed", () => {
    const defaultClasses = buttonVariants();
    expect(defaultClasses).toContain("disabled:bg-muted");
    expect(defaultClasses).toContain("disabled:text-muted-foreground");
    expect(defaultClasses).toContain("disabled:border-border");
    expect(defaultClasses).toContain("disabled:cursor-not-allowed");
    expect(defaultClasses).not.toContain("disabled:opacity-50");
  });
});
