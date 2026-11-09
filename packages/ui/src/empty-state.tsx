import type * as React from "react";

import { cn } from "./lib/utils.js";

export interface EmptyStateProps {
  message: string;
  className?: string;
}

export function EmptyState({ message, className }: EmptyStateProps) {
  return (
    <div
      data-slot="empty-state"
      className={cn("grid justify-items-center gap-2 text-center py-8 px-4", className)}
    >
      <p className="text-foreground font-semibold text-base leading-[22px] m-0">{message}</p>
    </div>
  );
}
