import { fireEvent, render, screen } from "@testing-library/react";
import * as React from "react";
import { describe, expect, it, vi } from "vitest";

import { Field } from "./field";
import { Select } from "./select";

describe("Select", () => {
  it("renders a real select with data-slot and given options", () => {
    const { container } = render(
      <Select defaultValue="opt2">
        <option value="opt1">Option 1</option>
        <option value="opt2">Option 2</option>
      </Select>,
    );
    const select = container.querySelector("select")!;
    expect(select).toBeDefined();
    expect(select.tagName).toBe("SELECT");
    expect(select.getAttribute("data-slot")).toBe("select");
    expect(select.options).toHaveLength(2);
    expect(select.value).toBe("opt2");
  });

  it("passes id, aria-describedby, and aria-invalid to the select element", () => {
    const { container } = render(
      <Select id="event-type" aria-describedby="event-type-help" aria-invalid="true">
        <option value="baptism">Baptism</option>
      </Select>,
    );
    const select = container.querySelector("select")!;
    expect(select.id).toBe("event-type");
    expect(select.getAttribute("aria-describedby")).toBe("event-type-help");
    expect(select.getAttribute("aria-invalid")).toBe("true");
  });

  it("places id on the select element, not the wrapper span", () => {
    const { container } = render(
      <Select id="my-select">
        <option value="1">One</option>
      </Select>,
    );
    const select = container.querySelector("select")!;
    const wrapper = container.querySelector("span")!;
    expect(select.id).toBe("my-select");
    expect(wrapper.id).toBeFalsy();
  });

  it("passes ref to the native select element", () => {
    const ref = React.createRef<HTMLSelectElement>();
    render(
      <Select ref={ref}>
        <option value="1">One</option>
      </Select>,
    );
    expect(ref.current).toBeInstanceOf(HTMLSelectElement);
    expect(ref.current?.tagName).toBe("SELECT");
  });

  it("calls onChange when selection changes", () => {
    const onChange = vi.fn();
    render(
      <Select onChange={onChange} defaultValue="a">
        <option value="a">A</option>
        <option value="b">B</option>
      </Select>,
    );
    const select = screen.getByRole("combobox");
    fireEvent.change(select, { target: { value: "b" } });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("renders an aria-hidden chevron icon in the wrapper", () => {
    const { container } = render(
      <Select>
        <option value="a">A</option>
      </Select>,
    );
    const wrapper = container.querySelector("span")!;
    expect(wrapper.className).toContain("relative");
    expect(wrapper.className).toContain("block");

    const svg = container.querySelector("svg")!;
    expect(svg).toBeDefined();
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.getAttribute("class")).toContain("pointer-events-none");
    expect(svg.getAttribute("class")).toContain("absolute");
    expect(svg.getAttribute("class")).toContain("right-2.5");
    expect(svg.getAttribute("class")).toContain("top-1/2");
    expect(svg.getAttribute("class")).toContain("-translate-y-1/2");
    expect(svg.getAttribute("class")).toContain("size-4");
    expect(svg.getAttribute("class")).toContain("text-muted-foreground");
  });

  it("renders with control height, touch variant, borders, background, and focus outline classes", () => {
    const { container } = render(
      <Select>
        <option value="a">A</option>
      </Select>,
    );
    const select = container.querySelector("select")!;
    expect(select.className).toContain("h-(--ch-size-control)");
    expect(select.className).toContain("touch:h-(--ch-size-touch)");
    expect(select.className).toContain("border-field-border");
    expect(select.className).toContain("hover:border-field-border-hover");
    expect(select.className).toContain("bg-card");
    expect(select.className).toContain("text-foreground");
    expect(select.className).toContain("rounded-md");
    expect(select.className).toContain("appearance-none");
    expect(select.className).toContain("pr-8");
    expect(select.className).toContain("focus-visible:outline-2");
    expect(select.className).toContain("focus-visible:outline-solid");
    expect(select.className).toContain("focus-visible:outline-offset-2");
    expect(select.className).toContain("focus-visible:outline-ring");
  });

  it("styles disabled and aria-invalid states without opacity modifiers", () => {
    const { container } = render(
      <Select disabled aria-invalid="true">
        <option value="a">A</option>
      </Select>,
    );
    const select = container.querySelector("select")!;
    expect(select.className).toContain("disabled:bg-muted");
    expect(select.className).toContain("disabled:text-muted-foreground");
    expect(select.className).toContain("disabled:cursor-not-allowed");
    expect(select.className).toContain("aria-invalid:border-destructive");
    expect(select.className).toContain("aria-invalid:outline-destructive");
    expect(select.className).not.toMatch(
      /(?:bg|ring|border|outline|text|fill)-[^\s"'`,]+\/(\d+|\[[^\]]+\])/,
    );
  });

  it("sets accessible name from Field label", () => {
    render(
      <Field label="Life event type">
        <Select id="custom-type-id">
          <option value="baptism">Baptism</option>
        </Select>
      </Field>,
    );
    const select = screen.getByRole("combobox", { name: "Life event type" });
    expect(select).toBeDefined();
    expect(select.id).toBe("custom-type-id");
  });
});
