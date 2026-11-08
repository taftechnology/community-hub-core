// Adapted from shadcn/ui. MIT License. See THIRD_PARTY_NOTICES.

import type * as React from "react";

import { cn } from "./lib/utils.js";

export type TextareaProps = React.ComponentProps<"textarea">;

function Textarea({ className, ...props }: TextareaProps) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex min-h-20 w-full min-w-0 rounded-md border border-field-border hover:border-field-border-hover bg-card px-3 py-2 text-base text-foreground placeholder:text-subtle-foreground shadow-xs transition-[color,box-shadow] outline-hidden focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground aria-invalid:border-destructive aria-invalid:outline-2 aria-invalid:outline-solid aria-invalid:outline-offset-2 aria-invalid:outline-destructive resize-y",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
