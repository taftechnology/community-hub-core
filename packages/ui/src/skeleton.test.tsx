import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Skeleton } from "./skeleton.js";

describe("Skeleton", () => {
  afterEach(() => {
    cleanup();
  });

  it("sets aria-hidden to true, renders 3 bars by default, and renders 5 bars when lines is 5", () => {
    const defaultRender = render(<Skeleton />);
    const defaultRoot = defaultRender.container.querySelector('[data-slot="skeleton"]');
    expect(defaultRoot).not.toBeNull();
    expect(defaultRoot?.getAttribute("aria-hidden")).toBe("true");
    expect(defaultRoot?.children).toHaveLength(3);

    defaultRender.unmount();

    const fiveRender = render(<Skeleton lines={5} />);
    const fiveRoot = fiveRender.container.querySelector('[data-slot="skeleton"]');
    expect(fiveRoot?.children).toHaveLength(5);
  });

  it("has empty text content and no element has role=status, aria-live or aria-busy", () => {
    const { container } = render(<Skeleton lines={4} />);

    expect(container.textContent).toBe("");
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.querySelector("[aria-live]")).toBeNull();
    expect(container.querySelector("[aria-busy]")).toBeNull();
  });

  it("applies motion-reduce:animate-none and animation pulse classes to each bar", () => {
    const { container } = render(<Skeleton lines={3} />);

    const bars = container.querySelectorAll('[data-slot="skeleton"] > div');
    expect(bars).toHaveLength(3);
    for (const bar of bars) {
      expect(bar.className).toContain("motion-reduce:animate-none");
      expect(bar.className).toContain("animate-pulse");
      expect(bar.className).toContain("h-3.5");
      expect(bar.className).toContain("rounded");
      expect(bar.className).toContain("bg-muted");
    }
  });
});
