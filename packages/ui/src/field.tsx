// Adapted from shadcn/ui. MIT License. See THIRD_PARTY_NOTICES.

import * as React from "react";

import { cn } from "./lib/utils.js";

export interface FieldProps {
  label: string;
  help?: string;
  error?: string;
  className?: string;
  children: React.ReactElement;
}

function Field({ label, help, error, className, children }: FieldProps) {
  const child = React.Children.only(children) as React.ReactElement<{
    id?: string;
    "aria-describedby"?: string;
    "aria-invalid"?: boolean | "true" | "false" | "grammar" | "spelling";
  }>;

  const generatedId = React.useId();
  const controlId = child.props.id ?? generatedId;
  const helpId = help ? `${controlId}-help` : undefined;
  const errorId = error ? `${controlId}-error` : undefined;

  const existingDescribedBy = child.props["aria-describedby"]?.trim();
  const describedByParts = [existingDescribedBy, helpId, errorId].filter(Boolean);
  const describedBy = describedByParts.length > 0 ? describedByParts.join(" ") : undefined;

  const childProps: Record<string, unknown> = {
    id: controlId,
  };

  if (describedBy !== undefined) {
    childProps["aria-describedby"] = describedBy;
  }

  if (error) {
    childProps["aria-invalid"] = true;
  }

  return (
    <div data-slot="field" className={cn("grid gap-1 min-w-0 content-start", className)}>
      <label
        htmlFor={controlId}
        data-slot="field-label"
        className="text-[15px] leading-[22px] font-semibold text-foreground"
      >
        {label}
      </label>
      {React.cloneElement(child, childProps)}
      {help ? (
        <p
          id={helpId}
          data-slot="field-help"
          className="text-[13px] leading-[18px] text-muted-foreground m-0"
        >
          {help}
        </p>
      ) : null}
      {error ? (
        <p
          id={errorId}
          data-slot="field-error"
          className="flex items-start gap-1 text-sm leading-5 text-destructive-ink"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}

export { Field };
