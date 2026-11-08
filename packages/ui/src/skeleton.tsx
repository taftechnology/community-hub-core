import type * as React from "react";

import { cn } from "./lib/utils.js";

export interface SkeletonProps {
  lines?: number;
  className?: string;
}

export function Skeleton({ lines = 3, className }: SkeletonProps) {
  return (
    <div data-slot="skeleton" aria-hidden="true" className={cn("grid gap-2.5", className)}>
      {Array.from({ length: lines }, (_, index) => (
        <div
          key={index}
          className="h-3.5 rounded bg-muted animate-pulse motion-reduce:animate-none"
        />
      ))}
    </div>
  );
}
