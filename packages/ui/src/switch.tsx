import type * as React from "react";

import { cn } from "./lib/utils.js";

export interface SwitchProps extends React.ComponentProps<"input"> {
  label: React.ReactNode;
}

function Switch({ label, className, ...props }: SwitchProps) {
  return (
    <label className="inline-flex items-center gap-2 cursor-pointer text-sm text-foreground touch:min-h-(--ch-size-touch) has-disabled:cursor-not-allowed has-disabled:text-muted-foreground">
      <span className="relative inline-flex items-center shrink-0">
        <input
          type="checkbox"
          role="switch"
          data-slot="switch"
          className={cn(
            "peer appearance-none w-[36px] h-[20px] rounded-full bg-input checked:bg-primary cursor-pointer transition-colors outline-hidden focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed",
            className,
          )}
          {...props}
        />
        <span
          aria-hidden="true"
          className="pointer-events-none absolute left-[2px] top-[2px] size-[16px] rounded-full bg-card transition-transform peer-checked:translate-x-[16px]"
        />
      </span>
      <span>{label}</span>
    </label>
  );
}

export { Switch };
