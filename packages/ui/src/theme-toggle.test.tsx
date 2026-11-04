import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ThemeToggle } from "./theme-toggle";

describe("ThemeToggle", () => {
  it("renders with accessible name 'Dark mode' and aria-pressed following theme", () => {
    const onToggle = vi.fn();
    const { rerender } = render(<ThemeToggle theme="light" onToggle={onToggle} />);

    const button = screen.getByRole("button", { name: "Dark mode" });
    expect(button).not.toBeNull();
    expect(button.getAttribute("aria-pressed")).toBe("false");

    rerender(<ThemeToggle theme="dark" onToggle={onToggle} />);
    expect(button.getAttribute("aria-pressed")).toBe("true");
  });

  it("calls onToggle exactly once on click", () => {
    const onToggle = vi.fn();
    render(<ThemeToggle theme="light" onToggle={onToggle} />);

    const button = screen.getByRole("button", { name: "Dark mode" });
    fireEvent.click(button);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("carries the size and outline focus classes", () => {
    render(<ThemeToggle theme="light" onToggle={() => {}} />);
    const button = screen.getByRole("button", { name: "Dark mode" });

    expect(button.className).toContain("size-(--ch-size-control)");
    expect(button.className).toContain("touch:size-(--ch-size-touch)");
    expect(button.className).toContain("focus-visible:outline-2");
    expect(button.className).toContain("focus-visible:outline-offset-2");
    expect(button.className).toContain("focus-visible:outline-ring");
  });

  it("renders aria-hidden icons for sun in light and moon in dark", () => {
    const { rerender, container } = render(<ThemeToggle theme="light" onToggle={() => {}} />);
    const lightSvg = container.querySelector("svg");
    expect(lightSvg).not.toBeNull();
    expect(lightSvg?.getAttribute("aria-hidden")).toBe("true");

    rerender(<ThemeToggle theme="dark" onToggle={() => {}} />);
    const darkSvg = container.querySelector("svg");
    expect(darkSvg).not.toBeNull();
    expect(darkSvg?.getAttribute("aria-hidden")).toBe("true");
  });
});
