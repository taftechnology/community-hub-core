import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "./table";

describe("Table classes and styling", () => {
  it("renders TableRow with row height and hover:bg-secondary-hover", () => {
    const { container } = render(
      <table>
        <tbody>
          <TableRow data-testid="row">
            <TableCell>Test</TableCell>
          </TableRow>
        </tbody>
      </table>,
    );
    const row = container.querySelector("tr")!;
    expect(row.className).toContain("h-(--ch-size-row)");
    expect(row.className).toContain("hover:bg-secondary-hover");
    expect(row.className).not.toContain("hover:bg-muted/50");
  });

  it("contains no opacity modifiers in any table subcomponent", () => {
    const { container } = render(
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Header</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell>Cell</TableCell>
          </TableRow>
        </TableBody>
        <TableFooter>
          <TableRow>
            <TableCell>Footer</TableCell>
          </TableRow>
        </TableFooter>
      </Table>,
    );

    const elements = container.querySelectorAll("*");
    for (const el of elements) {
      if (el.className) {
        expect(el.className).not.toMatch(
          /(?:bg|ring|border|outline|text|fill)-[^\s"'`,]+\/(\d+|\[[^\]]+\])/,
        );
      }
    }
  });
});
