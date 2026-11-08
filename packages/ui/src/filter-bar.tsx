import type * as React from "react";

import { Button } from "./button.js";
import { Field } from "./field.js";
import { Input } from "./input.js";
import { cn } from "./lib/utils.js";

export interface FilterBarProps {
  label: string;
  inputId?: string;
  value: string;
  onValueChange: (value: string) => void;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
  submitDisabled?: boolean;
  className?: string;
}

export function FilterBar({
  label,
  inputId,
  value,
  onValueChange,
  onSubmit,
  submitDisabled,
  className,
}: FilterBarProps) {
  return (
    <form onSubmit={onSubmit} className={cn("flex flex-wrap gap-2 items-end", className)}>
      <Field label={label} className="flex-1 min-w-0">
        <Input id={inputId} value={value} onChange={(e) => onValueChange(e.target.value)} />
      </Field>
      <Button type="submit" disabled={submitDisabled}>
        Search
      </Button>
    </form>
  );
}
