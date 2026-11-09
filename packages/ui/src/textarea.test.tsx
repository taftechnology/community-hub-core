import { fireEvent, render, screen } from "@testing-library/react";
import * as React from "react";
import { describe, expect, it, vi } from "vitest";

import { Field } from "./field";
import { Textarea } from "./textarea";

describe("Textarea", () => {
  it("renders a real textarea with data-slot", () => {
    const { container } = render(<Textarea defaultValue="Initial content" />);
    const textarea = container.querySelector("textarea")!;
    expect(textarea).toBeDefined();
    expect(textarea.tagName).toBe("TEXTAREA");
    expect(textarea.getAttribute("data-slot")).toBe("textarea");
    expect(textarea.value).toBe("Initial content");
  });

  it("passes rows, maxLength, id, aria-describedby, and aria-invalid to the textarea", () => {
    const { container } = render(
      <Textarea
        id="notes-field"
        rows={4}
        maxLength={500}
        aria-describedby="notes-help"
        aria-invalid="true"
      />,
    );
    const textarea = container.querySelector("textarea")!;
    expect(textarea.id).toBe("notes-field");
    expect(textarea.rows).toBe(4);
    expect(textarea.maxLength).toBe(500);
    expect(textarea.getAttribute("aria-describedby")).toBe("notes-help");
    expect(textarea.getAttribute("aria-invalid")).toBe("true");
  });

  it("passes ref to the native textarea element", () => {
    const ref = React.createRef<HTMLTextAreaElement>();
    render(<Textarea ref={ref} />);
    expect(ref.current).toBeInstanceOf(HTMLTextAreaElement);
    expect(ref.current?.tagName).toBe("TEXTAREA");
  });

  it("calls onChange when typing", () => {
    const onChange = vi.fn();
    render(<Textarea onChange={onChange} />);
    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "Updated text" } });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("renders with min-height, vertical resize, padding, borders, background, and focus outline classes", () => {
    const { container } = render(<Textarea />);
    const textarea = container.querySelector("textarea")!;
    expect(textarea.className).toContain("min-h-20");
    expect(textarea.className).toContain("py-2");
    expect(textarea.className).toContain("resize-y");
    expect(textarea.className).toContain("border-field-border");
    expect(textarea.className).toContain("hover:border-field-border-hover");
    expect(textarea.className).toContain("rounded-md");
    expect(textarea.className).toContain("bg-card");
    expect(textarea.className).toContain("text-foreground");
    expect(textarea.className).toContain("focus-visible:outline-2");
    expect(textarea.className).toContain("focus-visible:outline-solid");
    expect(textarea.className).toContain("focus-visible:outline-offset-2");
    expect(textarea.className).toContain("focus-visible:outline-ring");
  });

  it("styles disabled and aria-invalid states without opacity modifiers", () => {
    const { container } = render(<Textarea disabled aria-invalid="true" />);
    const textarea = container.querySelector("textarea")!;
    expect(textarea.className).toContain("disabled:bg-muted");
    expect(textarea.className).toContain("disabled:text-muted-foreground");
    expect(textarea.className).toContain("disabled:cursor-not-allowed");
    expect(textarea.className).toContain("aria-invalid:border-destructive");
    expect(textarea.className).toContain("aria-invalid:outline-destructive");
    expect(textarea.className).not.toMatch(
      /(?:bg|ring|border|outline|text|fill)-[^\s"'`,]+\/(\d+|\[[^\]]+\])/,
    );
  });

  it("sets accessible name from Field label", () => {
    render(
      <Field label="Pastoral notes">
        <Textarea id="custom-notes-id" />
      </Field>,
    );
    const textarea = screen.getByRole("textbox", { name: "Pastoral notes" });
    expect(textarea).toBeDefined();
    expect(textarea.id).toBe("custom-notes-id");
  });
});
