import type * as React from "react";

import { cn } from "./lib/utils.js";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./table.js";

export interface DataTableColumn<T> {
  key: string;
  header: string;
  render: (row: T) => React.ReactNode;
  primary?: boolean;
  srHeader?: boolean;
}

export interface DataTableProps<T> {
  columns: DataTableColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  "aria-label": string;
  className?: string;
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  "aria-label": ariaLabel,
  className,
}: DataTableProps<T>) {
  return (
    <Table
      role="table"
      aria-label={ariaLabel}
      className={cn("max-sm:block max-sm:w-full", className)}
    >
      <TableHeader role="rowgroup" className="max-sm:sr-only">
        <TableRow role="row" className="border-border">
          {columns.map((column) => (
            <TableHead
              key={column.key}
              role="columnheader"
              scope="col"
              className="whitespace-normal"
            >
              {column.srHeader ? <span className="sr-only">{column.header}</span> : column.header}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody role="rowgroup" className="max-sm:block max-sm:w-full">
        {rows.map((row) => (
          <TableRow
            key={rowKey(row)}
            role="row"
            className="max-sm:block max-sm:w-full max-sm:px-4 max-sm:py-3 max-sm:h-auto border-b border-border"
          >
            {columns.map((column) => (
              <TableCell
                key={column.key}
                role="cell"
                data-label={column.header}
                className={cn(
                  "whitespace-normal break-words max-sm:block max-sm:w-full max-sm:flex max-sm:justify-between max-sm:gap-3 max-sm:items-center max-sm:h-auto max-sm:border-0 max-sm:py-0.5 max-sm:px-0 max-sm:before:content-[attr(data-label)] max-sm:before:text-muted-foreground max-sm:before:text-[13px] max-sm:before:flex-none",
                  column.primary && "font-semibold max-sm:text-[15px] max-sm:before:content-none",
                )}
              >
                {column.render(row)}
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
