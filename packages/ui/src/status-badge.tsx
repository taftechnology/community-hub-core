import type * as React from "react";

import { cn } from "./lib/utils.js";

export type StatusBadgeTone = "success" | "warning" | "danger" | "neutral";

export interface StatusBadgeProps {
  tone: StatusBadgeTone;
  children: React.ReactNode;
  className?: string;
}

const TONE_CLASSES: Record<StatusBadgeTone, string> = {
  success: "text-primary-ink bg-tint border-tint-border",
  warning: "text-warning-ink bg-warning-tint border-warning-border",
  danger: "text-destructive-ink bg-destructive-tint border-destructive-border",
  neutral: "text-muted-foreground bg-muted border-border",
};

export function StatusBadge({ tone, children, className }: StatusBadgeProps) {
  return (
    <span
      data-slot="status-badge"
      data-tone={tone}
      className={cn(
        "inline-flex items-center gap-1 px-2 py-[1px] rounded-full border text-[13px] leading-[20px] font-semibold whitespace-nowrap",
        TONE_CLASSES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
