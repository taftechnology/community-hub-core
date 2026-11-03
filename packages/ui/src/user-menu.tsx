import type { ReactNode } from "react";
import { Menu } from "@base-ui/react/menu";
import { Check, User } from "lucide-react";

import { cn } from "./lib/utils";

export interface UserMenuProps {
  signedIn: boolean;
  onSignOut: () => void;
  signInHref: string;
  renderLink?: (item: { href: string; label: string }, props: { className: string }) => ReactNode;
  extraItems?: ReactNode;
  className?: string;
}

export interface UserMenuCheckboxItemProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  children: ReactNode;
  className?: string;
}

const SECONDARY_BUTTON_CLASSES =
  "inline-flex shrink-0 items-center justify-center rounded-lg border border-transparent text-sm font-medium transition-colors outline-hidden select-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring bg-secondary text-secondary-foreground hover:bg-secondary-hover h-(--ch-size-control) touch:h-(--ch-size-touch) px-3";

export function UserMenuCheckboxItem({
  checked,
  onCheckedChange,
  children,
  className,
}: UserMenuCheckboxItemProps) {
  return (
    <Menu.CheckboxItem
      checked={checked}
      onCheckedChange={(nextChecked) => onCheckedChange(nextChecked)}
      className={cn(
        "h-(--ch-size-control) px-3 flex items-center justify-between text-foreground text-sm font-medium rounded-md cursor-pointer hover:bg-secondary-hover data-[highlighted]:bg-secondary-hover focus:outline-none transition-colors select-none",
        className,
      )}
    >
      <span>{children}</span>
      <Menu.CheckboxItemIndicator className="inline-flex items-center justify-center">
        <Check className="size-4 shrink-0" aria-hidden="true" />
      </Menu.CheckboxItemIndicator>
    </Menu.CheckboxItem>
  );
}

export function UserMenu({
  signedIn,
  onSignOut,
  signInHref,
  renderLink,
  extraItems,
  className,
}: UserMenuProps) {
  if (!signedIn) {
    const linkProps = {
      className: cn(SECONDARY_BUTTON_CLASSES, className),
    };
    if (renderLink) {
      return renderLink({ href: signInHref, label: "Sign in" }, linkProps);
    }
    return (
      <a href={signInHref} {...linkProps}>
        Sign in
      </a>
    );
  }

  return (
    <Menu.Root>
      <Menu.Trigger
        aria-label="Account"
        className={cn(
          "size-(--ch-size-control) touch:size-(--ch-size-touch) inline-flex items-center justify-center rounded-md text-foreground hover:bg-secondary-hover focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring outline-hidden transition-colors",
          className,
        )}
      >
        <User className="size-4 shrink-0" aria-hidden="true" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner align="end" sideOffset={6} className="z-50">
          <Menu.Popup className="min-w-48 bg-card border border-border shadow-overlay rounded-lg p-1 text-foreground focus:outline-none">
            {extraItems && (
              <>
                {extraItems}
                <Menu.Separator className="h-px bg-border my-1" />
              </>
            )}
            <Menu.Item
              onClick={onSignOut}
              className="h-(--ch-size-control) px-3 flex items-center text-destructive-ink text-sm font-medium rounded-md cursor-pointer hover:bg-secondary-hover data-[highlighted]:bg-secondary-hover focus:outline-none transition-colors select-none"
            >
              Sign out
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
