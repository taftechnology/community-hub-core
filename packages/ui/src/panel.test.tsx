import { cleanup, render, screen } from "@testing-library/react";
import * as React from "react";
import { afterEach, describe, expect, it } from "vitest";

import { Panel } from "./panel.js";

describe("Panel", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders a section element with default level 2 heading when title is provided", () => {
    const { container } = render(
      <Panel title="Account Details">
        <p>Panel body</p>
      </Panel>,
    );
    const section = container.querySelector("section");
    expect(section).not.toBeNull();
    const heading = screen.getByRole("heading", { level: 2, name: "Account Details" });
    expect(heading).toBeDefined();
    expect(screen.getByText("Panel body")).toBeDefined();
  });

  it("renders headings with levels 3, 4, and 5 when specified", () => {
    const { rerender } = render(<Panel title="Level 3" level={3} />);
    expect(screen.getByRole("heading", { level: 3, name: "Level 3" })).toBeDefined();

    rerender(<Panel title="Level 4" level={4} />);
    expect(screen.getByRole("heading", { level: 4, name: "Level 4" })).toBeDefined();

    rerender(<Panel title="Level 5" level={5} />);
    expect(screen.getByRole("heading", { level: 5, name: "Level 5" })).toBeDefined();
  });

  it("renders no heading or head element when title and actions are omitted", () => {
    const { container } = render(
      <Panel>
        <p>Untitled content</p>
      </Panel>,
    );
    expect(screen.queryByRole("heading")).toBeNull();
    expect(container.querySelector("[data-slot='panel-head']")).toBeNull();
    expect(screen.getByText("Untitled content")).toBeDefined();
  });

  it("passes headingRef and headingTabIndex to the heading element", () => {
    const headingRef = React.createRef<HTMLHeadingElement>();
    render(<Panel title="Focusable Heading" headingRef={headingRef} headingTabIndex={-1} />);
    const heading = screen.getByRole("heading", { name: "Focusable Heading" });
    expect(headingRef.current).toBe(heading);
    expect(heading.getAttribute("tabindex")).toBe("-1");
  });

  it("renders head with actions when actions are provided", () => {
    render(<Panel title="Settings" actions={<button type="button">Edit</button>} />);
    expect(screen.getByRole("heading", { name: "Settings" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Edit" })).toBeDefined();
  });

  it("renders head with actions even without title", () => {
    render(
      <Panel actions={<button type="button">Action Only</button>}>
        <p>Body</p>
      </Panel>,
    );
    expect(screen.queryByRole("heading")).toBeNull();
    expect(screen.getByRole("button", { name: "Action Only" })).toBeDefined();
  });

  it("renders footer only when footer prop is provided", () => {
    const { rerender, container } = render(
      <Panel title="Form Panel">
        <p>Body</p>
      </Panel>,
    );
    expect(container.querySelector("[data-slot='panel-foot']")).toBeNull();

    rerender(
      <Panel title="Form Panel" footer={<button type="submit">Submit</button>}>
        <p>Body</p>
      </Panel>,
    );
    expect(screen.getByRole("button", { name: "Submit" })).toBeDefined();
    expect(container.querySelector("[data-slot='panel-foot']")).not.toBeNull();
  });

  it("applies className to section", () => {
    const { container } = render(<Panel className="custom-panel-class" />);
    const section = container.querySelector("section");
    expect(section?.className).toContain("custom-panel-class");
  });

  it("renders heading with panel-title typography classes including leading-[22px]", () => {
    render(<Panel title="Typography Test" />);
    const heading = screen.getByRole("heading", { name: "Typography Test" });
    expect(heading.className).toContain("font-semibold");
    expect(heading.className).toContain("text-foreground");
    expect(heading.className).toContain("text-base");
    expect(heading.className).toContain("leading-[22px]");
  });
});
