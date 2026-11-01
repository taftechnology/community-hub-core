import { render } from "@testing-library/react";
import axe from "axe-core";

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./table";

describe("Table", () => {
  it("passes axe on standard table structure", async () => {
    const { container } = render(
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">Given Name</TableHead>
            <TableHead scope="col">Family Name</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell>Ada</TableCell>
            <TableCell>Lovelace</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );
    const results = await axe.run(container, {
      rules: {
        "color-contrast": { enabled: false },
      },
    });
    expect(results.violations).toEqual([]);
  });
});
