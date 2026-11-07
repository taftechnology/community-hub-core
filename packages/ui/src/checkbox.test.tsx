import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Checkbox } from "./checkbox.js";

describe("Checkbox", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders a native input type='checkbox' inside its label with accessible name", () => {
    render(<Checkbox label="Subscribe to newsletter" />);
    const checkbox = screen.getByRole("checkbox", { name: "Subscribe to newsletter" });
    expect(checkbox).toBeDefined();
    expect(checkbox.tagName.toLowerCase()).toBe("input");
    expect(checkbox.getAttribute("type")).toBe("checkbox");
    const label = checkbox.closest("label");
    expect(label).not.toBeNull();
    expect(label?.textContent).toContain("Subscribe to newsletter");
  });

  it("has 18px sizing and accent-primary utility", () => {
    render(<Checkbox label="Option" />);
    const checkbox = screen.getByRole("checkbox", { name: "Option" });
    expect(checkbox.className).toContain("size-[18px]");
    expect(checkbox.className).toContain("accent-primary");
  });

  it("carries touch:min-h-(--ch-size-touch) on label", () => {
    render(<Checkbox label="Touch friendly" />);
    const checkbox = screen.getByRole("checkbox", { name: "Touch friendly" });
    const label = checkbox.closest("label");
    expect(label?.className).toContain("touch:min-h-(--ch-size-touch)");
  });

  it("has visible keyboard focus outline classes on the input", () => {
    render(<Checkbox label="Focus outline" />);
    const checkbox = screen.getByRole("checkbox", { name: "Focus outline" });
    expect(checkbox.className).toContain("focus-visible:outline-2");
    expect(checkbox.className).toContain("focus-visible:outline-solid");
    expect(checkbox.className).toContain("focus-visible:outline-offset-2");
    expect(checkbox.className).toContain("focus-visible:outline-ring");
    expect(checkbox.className).toContain("outline-hidden");
  });

  it("passes ref and native props to the input element", () => {
    const ref = React.createRef<HTMLInputElement>();
    const onChange = vi.fn();
    render(
      <Checkbox
        ref={ref}
        id="test-checkbox"
        name="terms"
        label="I accept the terms"
        checked={true}
        onChange={onChange}
        disabled
      />,
    );
    const checkbox = screen.getByRole("checkbox", { name: "I accept the terms" });
    expect(ref.current).toBe(checkbox);
    expect(checkbox.id).toBe("test-checkbox");
    expect(checkbox.getAttribute("name")).toBe("terms");
    expect((checkbox as HTMLInputElement).checked).toBe(true);
    expect((checkbox as HTMLInputElement).disabled).toBe(true);
  });

  it("handles change events when toggled", () => {
    let checked = false;
    render(
      <Checkbox
        label="Toggle me"
        checked={checked}
        onChange={(e) => {
          checked = e.target.checked;
        }}
      />,
    );
    const checkbox = screen.getByRole("checkbox", { name: "Toggle me" });
    fireEvent.click(checkbox);
    expect(checked).toBe(true);
  });
});
