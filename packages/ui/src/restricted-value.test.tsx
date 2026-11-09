import { cleanup, render, screen } from "@testing-library/react";
import * as React from "react";
import { afterEach, describe, expect, it } from "vitest";

import { RestrictedValue } from "./restricted-value.js";

describe("RestrictedValue", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders a root span with data-slot='restricted-value', native title, and no role", () => {
    const { container } = render(<RestrictedValue label="Household name hidden for your role" />);
    const root = container.querySelector('[data-slot="restricted-value"]');
    expect(root).not.toBeNull();
    expect(root?.tagName.toLowerCase()).toBe("span");
    expect(root?.getAttribute("title")).toBe("Hidden for your role");
    expect(root?.getAttribute("role")).toBeNull();
  });

  it("renders an em dash marked aria-hidden with font-bold and text-foreground", () => {
    const { container } = render(<RestrictedValue label="Household name hidden for your role" />);
    const root = container.querySelector('[data-slot="restricted-value"]')!;
    const dashSpan = root.querySelector('[aria-hidden="true"]');
    expect(dashSpan).not.toBeNull();
    expect(dashSpan?.tagName.toLowerCase()).toBe("span");
    expect(dashSpan?.textContent).toBe("—");
    expect(dashSpan?.textContent).toBe("\u2014");
    expect(dashSpan?.className).toContain("font-bold");
    expect(dashSpan?.className).toContain("text-foreground");
  });

  it("renders label in an sr-only span", () => {
    const { container } = render(<RestrictedValue label="Household name hidden for your role" />);
    const root = container.querySelector('[data-slot="restricted-value"]')!;
    const srSpan = root.querySelector("span.sr-only");
    expect(srSpan).not.toBeNull();
    expect(srSpan?.textContent).toBe("Household name hidden for your role");
  });

  it("provides accessible text from the label and does not contain the dash", () => {
    render(
      <button type="button">
        <RestrictedValue label="Household name hidden for your role" />
      </button>,
    );
    const button = screen.getByRole("button", {
      name: "Household name hidden for your role",
    });
    expect(button).toBeTruthy();
    expect(screen.queryByRole("button", { name: /—/ })).toBeNull();
  });

  it("does not carry text-muted-foreground so it never looks like None", () => {
    const { container } = render(<RestrictedValue label="Household name hidden for your role" />);
    const root = container.querySelector('[data-slot="restricted-value"]')!;
    expect(root.className).not.toContain("text-muted-foreground");
    const spans = root.querySelectorAll("span");
    for (const span of spans) {
      expect(span.className).not.toContain("text-muted-foreground");
    }
  });

  it("merges optional className", () => {
    const { container } = render(
      <RestrictedValue
        label="Household name hidden for your role"
        className="custom-restricted-class"
      />,
    );
    const root = container.querySelector('[data-slot="restricted-value"]')!;
    expect(root.className).toContain("custom-restricted-class");
  });
});
