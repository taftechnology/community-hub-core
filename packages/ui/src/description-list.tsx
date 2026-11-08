import type * as React from "react";

import { cn } from "./lib/utils.js";

export interface DescriptionListItem {
  term: string;
  value: React.ReactNode;
}

export interface DescriptionListProps {
  items: DescriptionListItem[];
  className?: string;
}

export function DescriptionList({ items, className }: DescriptionListProps) {
  return (
    <dl data-slot="description-list" className={cn("m-0 grid gap-0", className)}>
      {items.map((item, index) => (
        <div
          key={`${item.term}-${index}`}
          className="grid grid-cols-1 sm:grid-cols-[minmax(120px,200px)_minmax(0,1fr)] gap-1 sm:gap-4 py-2 border-b border-border last:border-b-0 text-base leading-6"
        >
          <dt className="text-muted-foreground text-[15px] leading-6 m-0 font-normal">
            {item.term}
          </dt>
          <dd className="m-0 break-words">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
