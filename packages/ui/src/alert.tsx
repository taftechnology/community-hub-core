// Adapted from shadcn/ui alert. MIT License. See THIRD_PARTY_NOTICES.

import type * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "./lib/utils";

const alertVariants = cva(
  "relative w-full rounded-lg border px-4 py-3 text-sm [&>svg]:pointer-events-none [&>svg]:shrink-0 [&>svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-background text-foreground border-border",
        destructive: "bg-background text-destructive border-destructive [&>svg]:text-current",
        warning: "bg-muted text-foreground border-border [&>svg]:text-current",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

function Alert({
  className,
  variant = "default",
  live,
  role,
  children,
  ...props
}: React.ComponentProps<"div"> &
  VariantProps<typeof alertVariants> & {
    live?: "polite" | "assertive";
  }) {
  const computedRole = role ?? (live === "polite" ? "status" : "alert");
  return (
    <div
      data-slot="alert"
      role={computedRole}
      className={cn(alertVariants({ variant }), className)}
      {...props}
    >
      {variant === "warning" && <span className="font-medium mr-1">Warning:</span>}
      {children}
    </div>
  );
}

function AlertTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-title"
      className={cn("mb-1 font-medium leading-none tracking-tight", className)}
      {...props}
    />
  );
}

function AlertDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-description"
      className={cn("text-sm [&_p]:leading-relaxed", className)}
      {...props}
    />
  );
}

export { Alert, AlertDescription, AlertTitle, alertVariants };
