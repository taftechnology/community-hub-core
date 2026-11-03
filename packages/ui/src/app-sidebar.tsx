import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";

import { cn } from "./lib/utils";
import { Logo } from "./logo";

export interface SidebarItem {
  id: string;
  label: string;
  href?: string;
  children?: SidebarItem[];
  heading?: "People" | "Outreach" | "Money";
}

export interface AppSidebarProps {
  items: SidebarItem[];
  footer: SidebarItem[];
  activeId?: string;
  siteTitle: string;
  switcher?: ReactNode;
  renderLink: (
    item: SidebarItem,
    props: { className: string; "aria-current"?: "page" | undefined },
  ) => ReactNode;
  className?: string;
}

function countRows(items: SidebarItem[]): number {
  let count = 0;
  for (const item of items) {
    count += 1;
    if (item.children) {
      count += countRows(item.children);
    }
  }
  return count;
}

export function AppSidebar({
  items,
  footer,
  activeId,
  siteTitle,
  switcher,
  renderLink,
  className,
}: AppSidebarProps) {
  const middleRowCount = countRows(items);
  const showHeadings = middleRowCount >= 8;

  function renderRow(item: SidebarItem, isChild = false) {
    const isActive = activeId === item.id;
    const rowClass = cn(
      "min-h-(--ch-size-nav-item) rounded-md flex items-center gap-2.5 px-2.5 text-sm font-medium w-full text-left transition-colors outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sidebar-ring select-none",
      isChild && "pl-9 font-normal text-sidebar-muted",
      isActive
        ? "bg-sidebar-selected text-sidebar-selected-foreground font-semibold"
        : "text-sidebar-foreground hover:bg-sidebar-hover",
    );

    if (item.href) {
      return renderLink(item, {
        className: rowClass,
        ...(isActive ? { "aria-current": "page" as const } : {}),
      });
    }

    return (
      <span
        data-slot="nav-label"
        className={rowClass}
        {...(isActive ? { "aria-current": "page" as const } : {})}
      >
        <span>{item.label}</span>
        {item.children && item.children.length > 0 && (
          <ChevronDown className="ml-auto size-4 shrink-0 text-sidebar-muted" aria-hidden="true" />
        )}
      </span>
    );
  }

  let previousHeading: string | undefined = undefined;

  return (
    <nav
      aria-label="Admin"
      className={cn(
        "bg-sidebar text-sidebar-foreground w-(--ch-size-sidebar) h-full flex flex-col min-h-0 border-r border-sidebar-border",
        className,
      )}
    >
      <div className="h-(--ch-size-top-bar) flex items-center gap-2 px-3 border-b border-sidebar-border shrink-0 font-bold text-base">
        <Logo variant="outline-white" />
        <span className="truncate">{siteTitle}</span>
      </div>

      {switcher && (
        <div data-slot="switcher" className="p-2 border-b border-sidebar-border shrink-0">
          {switcher}
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto p-2 flex flex-col gap-px">
        {items.map((item) => {
          let headingElement: ReactNode = null;
          if (showHeadings && item.heading && item.heading !== previousHeading) {
            headingElement = (
              <div
                key={`heading-${item.heading}`}
                role="presentation"
                data-slot="nav-heading"
                className="text-sidebar-heading px-2.5 pt-3 pb-1 text-xs font-semibold uppercase tracking-wider select-none"
              >
                {item.heading}
              </div>
            );
            previousHeading = item.heading;
          }

          return (
            <div key={item.id} className="flex flex-col gap-px">
              {headingElement}
              {renderRow(item, false)}
              {item.children?.map((child) => (
                <div key={child.id} className="flex flex-col gap-px">
                  {renderRow(child, true)}
                </div>
              ))}
            </div>
          );
        })}
      </div>

      {footer.length > 0 && (
        <div className="p-2 border-t border-sidebar-border shrink-0 flex flex-col gap-px">
          {footer.map((item) => (
            <div key={item.id} className="flex flex-col gap-px">
              {renderRow(item, false)}
              {item.children?.map((child) => (
                <div key={child.id} className="flex flex-col gap-px">
                  {renderRow(child, true)}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </nav>
  );
}
