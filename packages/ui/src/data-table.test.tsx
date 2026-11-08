import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { DataTable, type DataTableColumn } from "./data-table.js";

interface PersonRow {
  id: string;
  name: string;
  role: string;
  status: string;
}

const TEST_ROWS: PersonRow[] = [
  { id: "1", name: "Mira Tolland", role: "Coordinator", status: "Active" },
  { id: "2", name: "Owen Barrah", role: "Volunteer", status: "Inactive" },
];

const TEST_COLUMNS: DataTableColumn<PersonRow>[] = [
  {
    key: "name",
    header: "Full Name",
    primary: true,
    render: (row) => row.name,
  },
  {
    key: "role",
    header: "Parish Role",
    render: (row) => row.role,
  },
  {
    key: "status",
    header: "Status",
    srHeader: true,
    render: (row) => row.status,
  },
];

describe("DataTable", () => {
  afterEach(() => {
    cleanup();
  });

  it("finds table by aria-label and renders exactly one table element", () => {
    const { container } = render(
      <DataTable
        aria-label="Community Members"
        columns={TEST_COLUMNS}
        rows={TEST_ROWS}
        rowKey={(row) => row.id}
      />,
    );

    const table = screen.getByRole("table", { name: "Community Members" });
    expect(table).toBeDefined();
    expect(container.querySelectorAll("table")).toHaveLength(1);
  });

  it("sets explicit semantic roles on table, rowgroup, rows, headers and cells", () => {
    const { container } = render(
      <DataTable
        aria-label="Community Members"
        columns={TEST_COLUMNS}
        rows={TEST_ROWS}
        rowKey={(row) => row.id}
      />,
    );

    const table = container.querySelector("table");
    expect(table?.getAttribute("role")).toBe("table");

    const thead = container.querySelector("thead");
    expect(thead?.getAttribute("role")).toBe("rowgroup");

    const tbody = container.querySelector("tbody");
    expect(tbody?.getAttribute("role")).toBe("rowgroup");

    const rows = container.querySelectorAll("tr");
    expect(rows.length).toBe(3); // 1 header row + 2 data rows
    for (const tr of rows) {
      expect(tr.getAttribute("role")).toBe("row");
    }

    const headers = container.querySelectorAll("th");
    expect(headers.length).toBe(3);
    for (const th of headers) {
      expect(th.getAttribute("role")).toBe("columnheader");
      expect(th.getAttribute("scope")).toBe("col");
    }

    const cells = container.querySelectorAll("td");
    expect(cells.length).toBe(6);
    for (const td of cells) {
      expect(td.getAttribute("role")).toBe("cell");
    }
  });

  it("renders headers in order and srHeader is wrapped in an sr-only span while remaining accessible name", () => {
    render(
      <DataTable
        aria-label="Community Members"
        columns={TEST_COLUMNS}
        rows={TEST_ROWS}
        rowKey={(row) => row.id}
      />,
    );

    const columnHeaders = screen.getAllByRole("columnheader");
    expect(columnHeaders).toHaveLength(3);
    expect(columnHeaders[0]?.textContent).toBe("Full Name");
    expect(columnHeaders[1]?.textContent).toBe("Parish Role");
    expect(columnHeaders[2]?.textContent).toBe("Status");

    const statusHeader = screen.getByRole("columnheader", { name: "Status" });
    const srSpan = statusHeader.querySelector("span.sr-only");
    expect(srSpan).not.toBeNull();
    expect(srSpan?.textContent).toBe("Status");
  });

  it("renders each row and each column's render output", () => {
    render(
      <DataTable
        aria-label="Community Members"
        columns={TEST_COLUMNS}
        rows={TEST_ROWS}
        rowKey={(row) => row.id}
      />,
    );

    expect(screen.getByText("Mira Tolland")).toBeDefined();
    expect(screen.getByText("Coordinator")).toBeDefined();
    expect(screen.getByText("Active")).toBeDefined();
    expect(screen.getByText("Owen Barrah")).toBeDefined();
    expect(screen.getByText("Volunteer")).toBeDefined();
    expect(screen.getByText("Inactive")).toBeDefined();
  });

  it("sets every td data-label to its column header and never to a row value", () => {
    const { container } = render(
      <DataTable
        aria-label="Community Members"
        columns={TEST_COLUMNS}
        rows={TEST_ROWS}
        rowKey={(row) => row.id}
      />,
    );

    const cells = container.querySelectorAll("td");
    expect(cells.length).toBe(6);

    const rowValues = [
      "Mira Tolland",
      "Owen Barrah",
      "Coordinator",
      "Volunteer",
      "Active",
      "Inactive",
    ];

    for (const td of cells) {
      const dataLabel = td.getAttribute("data-label");
      expect(dataLabel).toBeTruthy();
      expect(["Full Name", "Parish Role", "Status"]).toContain(dataLabel);
      expect(rowValues).not.toContain(dataLabel);
    }
  });

  it("applies whitespace-normal to all th and td elements", () => {
    const { container } = render(
      <DataTable
        aria-label="Community Members"
        columns={TEST_COLUMNS}
        rows={TEST_ROWS}
        rowKey={(row) => row.id}
      />,
    );

    const headers = container.querySelectorAll("th");
    for (const th of headers) {
      expect(th.className).toContain("whitespace-normal");
    }

    const cells = container.querySelectorAll("td");
    for (const td of cells) {
      expect(td.className).toContain("whitespace-normal");
    }
  });

  it("applies max-sm:before:content-[attr(data-label)] to non-primary td and max-sm:before:content-none to primary td", () => {
    const { container } = render(
      <DataTable
        aria-label="Community Members"
        columns={TEST_COLUMNS}
        rows={TEST_ROWS}
        rowKey={(row) => row.id}
      />,
    );

    const primaryCells = container.querySelectorAll("td[data-label='Full Name']");
    expect(primaryCells.length).toBe(2);
    for (const td of primaryCells) {
      expect(td.className).toContain("max-sm:before:content-none");
      expect(td.className).not.toContain("max-sm:before:content-[attr(data-label)]");
    }

    const nonPrimaryCells = container.querySelectorAll(
      "td[data-label='Parish Role'], td[data-label='Status']",
    );
    expect(nonPrimaryCells.length).toBe(4);
    for (const td of nonPrimaryCells) {
      expect(td.className).toContain("max-sm:before:content-[attr(data-label)]");
      expect(td.className).not.toContain("max-sm:before:content-none");
    }
  });
});
