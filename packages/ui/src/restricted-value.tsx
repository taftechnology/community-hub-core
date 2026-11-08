import type * as React from "react";

import { cn } from "./lib/utils.js";

export interface RestrictedValueProps {
  label: string;
  className?: string;
}

export function RestrictedValue({ label, className }: RestrictedValueProps) {
  return (
    <span data-slot="restricted-value" title="Hidden for your role" className={cn(className)}>
      <span aria-hidden="true" className="font-bold text-foreground">
        —
      </span>
      <span className="sr-only">{label}</span>
    </span>
  );
}
