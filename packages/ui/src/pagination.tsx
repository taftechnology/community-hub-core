import type * as React from "react";

import { Button } from "./button.js";
import { cn } from "./lib/utils.js";

export interface PaginationProps {
  cursor: string | null;
  onNext: (cursor: string) => void;
  className?: string;
}

export function Pagination({ cursor, onNext, className }: PaginationProps) {
  if (cursor === null) {
    return null;
  }

  return (
    <div className={cn("flex flex-wrap gap-2 justify-between items-center", className)}>
      <Button type="button" onClick={() => onNext(cursor)}>
        Next page
      </Button>
    </div>
  );
}
