import { cleanup, render, screen } from "@testing-library/react";
import * as React from "react";
import { afterEach, describe, expect, it } from "vitest";

import { DescriptionList } from "./description-list.js";

describe("DescriptionList", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders a real dl root element with dt and dd pairs in order", () => {
    const items = [
      { term: "Name", value: "Ada Lovelace" },
      { term: "Role", value: "Mathematician" },
    ];
    const { container } = render(<DescriptionList items={items} />);

    const dl = container.firstElementChild;
    expect(dl?.tagName).toBe("DL");
    expect(dl?.getAttribute("data-slot")).toBe("description-list");

    const rows = dl?.querySelectorAll("div");
    expect(rows?.length).toBe(2);
    for (const row of rows ?? []) {
      expect(row.className).toContain("border-b");
      expect(row.className).toContain("border-border");
      expect(row.className).toContain("last:border-b-0");
    }

    const dts = container.querySelectorAll("dt");
    const dds = container.querySelectorAll("dd");

    expect(dts).toHaveLength(2);
    expect(dds).toHaveLength(2);
    expect(dts[0]?.textContent).toBe("Name");
    expect(dds[0]?.textContent).toBe("Ada Lovelace");
    expect(dts[1]?.textContent).toBe("Role");
    expect(dds[1]?.textContent).toBe("Mathematician");
  });

  it("renders ReactNode values properly", () => {
    const items = [
      {
        term: "Status",
        value: <span data-testid="custom-node">Active Status</span>,
      },
    ];
    render(<DescriptionList items={items} />);

    expect(screen.getByText("Status")).toBeDefined();
    expect(screen.getByTestId("custom-node").textContent).toBe("Active Status");
  });

  it("renders an empty dl with no rows when items is empty", () => {
    const { container } = render(<DescriptionList items={[]} />);
    const dl = container.firstElementChild;
    expect(dl?.tagName).toBe("DL");
    expect(dl?.children.length).toBe(0);
    expect(container.querySelectorAll("dt")).toHaveLength(0);
    expect(container.querySelectorAll("dd")).toHaveLength(0);
  });

  it("applies custom className to dl element", () => {
    const { container } = render(<DescriptionList items={[]} className="custom-dl-class" />);
    const dl = container.querySelector("dl");
    expect(dl?.className).toContain("custom-dl-class");
  });
});
