import type { ReactNode } from "react";
import { cn } from "./lib/utils";

export interface AppShellProps {
  sidebar: ReactNode;
  topBar: ReactNode;
  drawer?: ReactNode;
  children: ReactNode;
  className?: string;
}

export function AppShell({ sidebar, topBar, drawer, children, className }: AppShellProps) {
  return (
    <div
      className={cn(
        "grid min-h-screen h-screen overflow-hidden bg-background grid-cols-1 lg:grid-cols-[var(--ch-size-sidebar)_minmax(0,1fr)]",
        className,
      )}
    >
      <div data-slot="sidebar" className="hidden lg:block h-full min-h-0 print:hidden">
        {sidebar}
      </div>
      <div className="flex flex-col min-w-0 min-h-0 h-full">
        <div data-slot="top-bar" className="shrink-0 print:hidden">
          {topBar}
        </div>
        <main className="flex-1 min-h-0 overflow-auto p-(--ch-space-4) lg:p-(--ch-space-6) flex flex-col gap-(--ch-space-4)">
          {children}
        </main>
      </div>
      {drawer}
    </div>
  );
}
