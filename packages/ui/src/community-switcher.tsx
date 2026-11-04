import { Menu } from "@base-ui/react/menu";
import { ChevronDown } from "lucide-react";

import { cn } from "./lib/utils";

export interface Community {
  id: string;
  label: string;
}

export interface CommunitySwitcherProps {
  communities: Community[];
  currentId: string;
  onChange: (id: string) => void;
  className?: string;
}

export function CommunitySwitcher({
  communities,
  currentId,
  onChange,
  className,
}: CommunitySwitcherProps) {
  if (communities.length < 2) {
    return null;
  }

  const current = communities.find((c) => c.id === currentId) ?? communities[0];

  return (
    <Menu.Root>
      <Menu.Trigger
        className={cn(
          "w-full h-(--ch-size-control) touch:h-(--ch-size-touch) px-3 flex items-center justify-between gap-2 rounded-md bg-sidebar text-sidebar-foreground border border-sidebar-input hover:bg-sidebar-hover focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-sidebar-ring outline-hidden transition-colors text-sm font-medium",
          className,
        )}
      >
        <span className="truncate">{current?.label}</span>
        <ChevronDown className="size-4 shrink-0 text-sidebar-foreground" aria-hidden="true" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner align="start" sideOffset={4} className="z-50">
          <Menu.Popup className="min-w-48 bg-sidebar text-sidebar-foreground border border-sidebar-input shadow-overlay rounded-lg p-1 focus:outline-none">
            {communities.map((community) => (
              <Menu.Item
                key={community.id}
                onClick={() => onChange(community.id)}
                className="h-(--ch-size-control) touch:min-h-(--ch-size-touch) px-3 flex items-center text-sidebar-foreground text-sm rounded-md cursor-pointer hover:bg-sidebar-hover data-[highlighted]:bg-sidebar-hover focus:outline-none transition-colors select-none"
              >
                <span className="truncate">{community.label}</span>
              </Menu.Item>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
