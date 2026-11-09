// Adapted from shadcn/ui. MIT License. See THIRD_PARTY_NOTICES.

import type * as React from "react";
import { ChevronDown } from "lucide-react";

import { cn } from "./lib/utils.js";

export type SelectProps = React.ComponentProps<"select">;

function Select({ className, children, ...props }: SelectProps) {
  return (
    <span className="relative block">
      <select
        data-slot="select"
        className={cn(
          "flex h-(--ch-size-control) touch:h-(--ch-size-touch) w-full min-w-0 rounded-md border border-field-border hover:border-field-border-hover bg-card px-3 py-1 text-base text-foreground placeholder:text-subtle-foreground shadow-xs transition-[color,box-shadow] outline-hidden focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground aria-invalid:border-destructive aria-invalid:outline-2 aria-invalid:outline-solid aria-invalid:outline-offset-2 aria-invalid:outline-destructive appearance-none pr-8",
          className,
        )}
        {...props}
      >
        {children}
      </select>
      <ChevronDown
        aria-hidden="true"
        className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground"
      />
    </span>
  );
}

export { Select };
