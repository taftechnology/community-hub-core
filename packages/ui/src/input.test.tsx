import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Input } from "./input";

describe("Input classes and styling", () => {
  it("renders with control height and touch media variant", () => {
    const { container } = render(<Input />);
    const input = container.querySelector("input")!;
    expect(input.className).toContain("h-(--ch-size-control)");
    expect(input.className).toContain("touch:h-(--ch-size-touch)");
  });

  it("renders with field borders, card background, foreground text, and subtle placeholder", () => {
    const { container } = render(<Input placeholder="Type here" />);
    const input = container.querySelector("input")!;
    expect(input.className).toContain("border-field-border");
    expect(input.className).toContain("hover:border-field-border-hover");
    expect(input.className).toContain("bg-card");
    expect(input.className).toContain("text-foreground");
    expect(input.className).toContain("placeholder:text-subtle-foreground");
  });

  it("renders with 2px solid outline focus with 2px offset and no ring opacity", () => {
    const { container } = render(<Input />);
    const input = container.querySelector("input")!;
    expect(input.className).toContain("focus-visible:outline-2");
    expect(input.className).toContain("focus-visible:outline-offset-2");
    expect(input.className).toContain("focus-visible:outline-ring");
    expect(input.className).not.toContain("ring-ring/50");
    expect(input.className).not.toContain("ring-[3px]");
  });

  it("handles aria-invalid with solid border-destructive and outline", () => {
    const { container } = render(<Input aria-invalid="true" />);
    const input = container.querySelector("input")!;
    expect(input.className).toContain("aria-invalid:border-destructive");
    expect(input.className).toContain("aria-invalid:outline-destructive");
    expect(input.className).not.toContain("aria-invalid:ring-destructive/20");
  });

  it("styles disabled state as bg-muted text-muted-foreground", () => {
    const { container } = render(<Input disabled />);
    const input = container.querySelector("input")!;
    expect(input.className).toContain("disabled:bg-muted");
    expect(input.className).toContain("disabled:text-muted-foreground");
    expect(input.className).not.toContain("disabled:opacity-50");
  });

  it("contains no opacity modifiers anywhere in className", () => {
    const { container } = render(<Input />);
    const input = container.querySelector("input")!;
    expect(input.className).not.toMatch(
      /(?:bg|ring|border|outline|text|fill)-[^\s"'`,]+\/(\d+|\[[^\]]+\])/,
    );
  });
});
