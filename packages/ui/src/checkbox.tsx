import type * as React from "react";

import { cn } from "./lib/utils.js";

export interface CheckboxProps extends React.ComponentProps<"input"> {
  label: React.ReactNode;
}

function Checkbox({ label, className, ...props }: CheckboxProps) {
  return (
    <label className="inline-flex items-center gap-2 cursor-pointer text-sm text-foreground touch:min-h-(--ch-size-touch) has-disabled:cursor-not-allowed has-disabled:text-muted-foreground">
      <input
        type="checkbox"
        data-slot="checkbox"
        className={cn(
          "size-[18px] shrink-0 accent-primary cursor-pointer rounded-xs outline-hidden focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed",
          className,
        )}
        {...props}
      />
      <span>{label}</span>
    </label>
  );
}

export { Checkbox };
