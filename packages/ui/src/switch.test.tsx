import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as React from "react";
import { afterEach, describe, expect, it } from "vitest";

import { Switch } from "./switch.js";

describe("Switch", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders a native input type='checkbox' role='switch' inside label with accessible name", () => {
    render(<Switch label="giving" />);
    const switchControl = screen.getByRole("switch", { name: "giving" });
    expect(switchControl).toBeDefined();
    expect(switchControl.tagName.toLowerCase()).toBe("input");
    expect(switchControl.getAttribute("type")).toBe("checkbox");
    expect(switchControl.getAttribute("role")).toBe("switch");
    const label = switchControl.closest("label");
    expect(label).not.toBeNull();
    expect(label?.textContent).toContain("giving");
  });

  it("has a 36px by 20px track with bg-input when off and bg-primary when on", () => {
    render(<Switch label="Feature" />);
    const switchControl = screen.getByRole("switch", { name: "Feature" });
    expect(switchControl.className).toContain("w-[36px]");
    expect(switchControl.className).toContain("h-[20px]");
    expect(switchControl.className).toContain("bg-input");
    expect(switchControl.className).toContain("checked:bg-primary");
  });

  it("has a 16px thumb using a token colour and not #fff", () => {
    const { container } = render(<Switch label="Feature" />);
    const thumb = container.querySelector("[aria-hidden='true']");
    expect(thumb).not.toBeNull();
    expect(thumb?.className).toContain("size-[16px]");
    expect(thumb?.className).toContain("bg-card");
    expect(thumb?.className).not.toContain("#fff");
  });

  it("carries touch:min-h-(--ch-size-touch) on label", () => {
    render(<Switch label="Touch switch" />);
    const switchControl = screen.getByRole("switch", { name: "Touch switch" });
    const label = switchControl.closest("label");
    expect(label?.className).toContain("touch:min-h-(--ch-size-touch)");
  });

  it("has visible keyboard focus outline classes on the input", () => {
    render(<Switch label="Focus switch" />);
    const switchControl = screen.getByRole("switch", { name: "Focus switch" });
    expect(switchControl.className).toContain("focus-visible:outline-2");
    expect(switchControl.className).toContain("focus-visible:outline-solid");
    expect(switchControl.className).toContain("focus-visible:outline-offset-2");
    expect(switchControl.className).toContain("focus-visible:outline-ring");
    expect(switchControl.className).toContain("outline-hidden");
  });

  it("preserves native event handling with event.target.checked", () => {
    let turned = false;
    render(
      <Switch
        label="giving"
        checked={turned}
        onChange={(e) => {
          turned = e.target.checked;
        }}
      />,
    );
    const switchControl = screen.getByRole("switch", { name: "giving" });
    fireEvent.click(switchControl);
    expect(turned).toBe(true);
  });

  it("passes ref and native props to the input element", () => {
    const ref = React.createRef<HTMLInputElement>();
    render(<Switch ref={ref} id="switch-id" name="module_status" label="Status" disabled />);
    const switchControl = screen.getByRole("switch", { name: "Status" });
    expect(ref.current).toBe(switchControl);
    expect(switchControl.id).toBe("switch-id");
    expect(switchControl.getAttribute("name")).toBe("module_status");
    expect((switchControl as HTMLInputElement).disabled).toBe(true);
  });

  it("takes focus and has tabIndex 0", () => {
    render(<Switch label="Accessible switch" />);
    const switchControl = screen.getByRole("switch", { name: "Accessible switch" });
    (switchControl as HTMLInputElement).focus();
    expect(document.activeElement).toBe(switchControl);
    expect((switchControl as HTMLInputElement).tabIndex).toBe(0);
  });
});
