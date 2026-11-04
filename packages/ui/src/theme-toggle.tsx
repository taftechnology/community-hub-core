import { Moon, Sun } from "lucide-react";

import { cn } from "./lib/utils";
import type { Theme } from "./theme";

export interface ThemeToggleProps {
  theme: Theme;
  onToggle: () => void;
  className?: string;
}

export function ThemeToggle({ theme, onToggle, className }: ThemeToggleProps) {
  const isDark = theme === "dark";

  return (
    <button
      type="button"
      aria-label="Dark mode"
      aria-pressed={isDark}
      onClick={onToggle}
      className={cn(
        "inline-flex items-center justify-center rounded-md size-(--ch-size-control) touch:size-(--ch-size-touch) text-foreground hover:bg-secondary-hover focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring outline-hidden transition-colors",
        className,
      )}
    >
      {isDark ? (
        <Moon className="size-4 shrink-0" aria-hidden="true" />
      ) : (
        <Sun className="size-4 shrink-0" aria-hidden="true" />
      )}
    </button>
  );
}
