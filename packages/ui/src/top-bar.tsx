import type { ReactNode, Ref } from "react";
import { ArrowLeft, Menu } from "lucide-react";

import { cn } from "./lib/utils";

export interface TopBarProps {
  title: string;
  titleRef?: Ref<HTMLHeadingElement>;
  backHref?: string;
  backLabel?: string;
  renderLink?: (
    item: { href: string; label: string },
    props: { className: string; "aria-label"?: string },
  ) => ReactNode;
  onMenu?: () => void;
  menuOpen?: boolean;
  actions?: ReactNode;
  menuButtonRef?: Ref<HTMLButtonElement>;
  className?: string;
}

export function TopBar({
  title,
  titleRef,
  backHref,
  backLabel = "Back",
  renderLink,
  onMenu,
  menuOpen = false,
  actions,
  menuButtonRef,
  className,
}: TopBarProps) {
  let backElement: ReactNode = null;
  if (backHref) {
    const linkProps = {
      className:
        "size-(--ch-size-touch) flex items-center justify-center rounded-md text-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring outline-none",
      "aria-label": backLabel,
    };
    if (renderLink) {
      backElement = renderLink({ href: backHref, label: backLabel }, linkProps);
    } else {
      backElement = (
        <a href={backHref} {...linkProps}>
          <ArrowLeft className="size-4" aria-hidden="true" />
          <span className="sr-only">{backLabel}</span>
        </a>
      );
    }
  }

  return (
    <header
      className={cn(
        "h-(--ch-size-top-bar) bg-card border-b border-border px-5 flex items-center justify-between gap-3 shrink-0",
        className,
      )}
    >
      <div className="flex items-center gap-2 min-w-0 flex-1">
        {onMenu && (
          <button
            type="button"
            ref={menuButtonRef}
            aria-label="Open menu"
            aria-expanded={menuOpen}
            onClick={onMenu}
            className="size-(--ch-size-touch) lg:hidden flex items-center justify-center rounded-md text-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring outline-none"
          >
            <Menu className="size-5" aria-hidden="true" />
          </button>
        )}
        {backElement}
        <h1
          ref={titleRef}
          tabIndex={-1}
          className="text-[18px] leading-[24px] sm:text-[22px] sm:leading-[28px] font-bold text-foreground truncate outline-none"
        >
          {title}
        </h1>
      </div>

      {actions && (
        <div data-slot="actions" className="flex items-center gap-2 shrink-0">
          {actions}
        </div>
      )}
    </header>
  );
}
