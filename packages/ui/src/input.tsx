// Adapted from shadcn/ui. MIT License. See THIRD_PARTY_NOTICES.

import type * as React from "react";

import { cn } from "./lib/utils.js";

function Input({ className, type = "text", ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "flex h-(--ch-size-control) max-sm:@media(pointer:coarse):h-(--ch-size-touch) w-full min-w-0 rounded-md border border-field-border hover:border-field-border-hover bg-card px-3 py-1 text-base text-foreground placeholder:text-subtle-foreground shadow-xs transition-[color,box-shadow] outline-none file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground selection:bg-primary selection:text-primary-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground aria-invalid:border-destructive aria-invalid:outline-2 aria-invalid:outline-offset-2 aria-invalid:outline-destructive",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
