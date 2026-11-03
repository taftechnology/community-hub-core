import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Logo } from "./logo";

describe("Logo", () => {
  it("renders with no label as aria-hidden with no role and no title", () => {
    const { container } = render(<Logo variant="outline-white" />);
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    expect(svg?.getAttribute("role")).toBeNull();
    expect(svg?.querySelector("title")).toBeNull();
    expect(svg?.getAttribute("stroke")).toBe("currentColor");
  });

  it("renders with a label as role='img' and accessible name", () => {
    const { container } = render(<Logo variant="outline-teal" label="Community Hub" />);
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute("role")).toBe("img");
    expect(svg?.getAttribute("aria-label")).toBe("Community Hub");
    expect(svg?.getAttribute("aria-hidden")).toBeNull();
  });

  it("uses the design viewBox and four circles geometry", () => {
    const { container } = render(<Logo variant="outline-white" />);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("viewBox")).toBe("58 47 927 927");
    const circles = container.querySelectorAll("circle");
    expect(circles).toHaveLength(4);
    expect(circles[0]?.getAttribute("cx")).toBe("521.5");
    expect(circles[0]?.getAttribute("cy")).toBe("368.5");
    expect(circles[0]?.getAttribute("r")).toBe("288.5");
  });

  it("applies variant classes for text color", () => {
    const { container: whiteContainer } = render(<Logo variant="outline-white" />);
    expect(whiteContainer.querySelector("svg")?.classList.contains("text-sidebar-foreground")).toBe(
      true,
    );

    const { container: tealContainer } = render(<Logo variant="outline-teal" />);
    expect(tealContainer.querySelector("svg")?.classList.contains("text-primary")).toBe(true);
  });

  it("uses default size of 30 or custom size", () => {
    const { container: defaultContainer } = render(<Logo variant="outline-white" />);
    const defaultSvg = defaultContainer.querySelector("svg");
    expect(defaultSvg?.getAttribute("width")).toBe("30");
    expect(defaultSvg?.getAttribute("height")).toBe("30");

    const { container: customContainer } = render(<Logo variant="outline-white" size={48} />);
    const customSvg = customContainer.querySelector("svg");
    expect(customSvg?.getAttribute("width")).toBe("48");
    expect(customSvg?.getAttribute("height")).toBe("48");
  });
});
