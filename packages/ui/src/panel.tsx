import type * as React from "react";

import { cn } from "./lib/utils.js";

export interface PanelProps {
  title?: string;
  level?: 2 | 3 | 4 | 5;
  headingRef?: React.Ref<HTMLHeadingElement>;
  headingTabIndex?: number;
  actions?: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
  children?: React.ReactNode;
}

function Panel({
  title,
  level = 2,
  headingRef,
  headingTabIndex,
  actions,
  footer,
  className,
  children,
}: PanelProps) {
  const hasHead = Boolean(title || actions);
  const hasFoot = Boolean(footer);
  const HeadingTag = `h${level}` as "h2" | "h3" | "h4" | "h5";

  return (
    <section
      data-slot="panel"
      className={cn("bg-card border border-border rounded-lg min-w-0", className)}
    >
      {hasHead && (
        <div
          data-slot="panel-head"
          className="flex flex-wrap gap-2 justify-between items-center px-4 py-3 border-b border-border"
        >
          {title && (
            <HeadingTag
              ref={headingRef}
              tabIndex={headingTabIndex}
              className="font-semibold text-foreground text-base leading-[22px]"
            >
              {title}
            </HeadingTag>
          )}
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </div>
      )}
      <div data-slot="panel-body" className="p-4 grid gap-4">
        {children}
      </div>
      {hasFoot && (
        <div
          data-slot="panel-foot"
          className="px-4 py-3 border-t border-border flex flex-wrap gap-2 justify-end"
        >
          {footer}
        </div>
      )}
    </section>
  );
}

export { Panel };
