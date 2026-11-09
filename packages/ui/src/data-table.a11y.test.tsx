import { render } from "@testing-library/react";
import axe from "axe-core";
import { describe, expect, it } from "vitest";

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

describe("DataTable a11y", () => {
  it("passes axe on standard data table structure with srHeader and rows", async () => {
    const { container } = render(
      <DataTable
        aria-label="Community Members"
        columns={TEST_COLUMNS}
        rows={TEST_ROWS}
        rowKey={(row) => row.id}
      />,
    );

    const results = await axe.run(container, {
      rules: {
        "color-contrast": { enabled: false },
      },
    });
    expect(results.violations).toEqual([]);
  });
});
