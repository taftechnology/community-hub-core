import type { ReactNode } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { X } from "lucide-react";

import { cn } from "./lib/utils";

export interface DrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  label: string;
  children: ReactNode;
  className?: string;
}

export function Drawer({ open, onOpenChange, label, children, className }: DrawerProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-scrim" />
        <Dialog.Popup
          aria-label={label}
          className={cn(
            "fixed inset-y-0 left-0 z-50 w-(--ch-size-sidebar) max-w-[85vw] bg-sidebar text-sidebar-foreground flex flex-col shadow-overlay focus:outline-none",
            className,
          )}
        >
          <Dialog.Title className="sr-only">{label}</Dialog.Title>
          <div className="flex items-center justify-end p-2 shrink-0">
            <Dialog.Close
              aria-label="Close menu"
              className="size-(--ch-size-touch) flex items-center justify-center rounded-md text-sidebar-foreground hover:bg-sidebar-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sidebar-ring outline-none"
            >
              <X className="size-5" aria-hidden="true" />
            </Dialog.Close>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto">{children}</div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
