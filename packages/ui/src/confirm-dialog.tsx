import { Dialog } from "@base-ui/react/dialog";

import { Alert } from "./alert";
import { Button } from "./button";

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel: string;
  tone?: "danger" | "default";
  onConfirm: () => void;
  pending?: boolean;
  error?: string;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel,
  tone = "default",
  onConfirm,
  pending = false,
  error,
}: ConfirmDialogProps) {
  return (
    <Dialog.Root open={open} onOpenChange={(next) => onOpenChange(next)} modal>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-scrim" />
        <Dialog.Popup
          finalFocus={true}
          className="fixed left-1/2 top-1/2 z-50 w-[85vw] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-card p-4 text-card-foreground shadow-overlay flex flex-col gap-3 focus:outline-none"
        >
          <Dialog.Title className="m-0 text-base font-semibold leading-[22px] text-foreground">
            {title}
          </Dialog.Title>
          <Dialog.Description className="m-0 text-sm text-muted-foreground">
            {description}
          </Dialog.Description>
          {error ? <Alert variant="destructive">{error}</Alert> : null}
          <div className="flex flex-wrap justify-end gap-2">
            <Dialog.Close render={<Button variant="outline" />}>{cancelLabel}</Dialog.Close>
            <Button
              variant={tone === "danger" ? "destructive" : "default"}
              aria-busy={pending ? true : undefined}
              disabled={pending}
              onClick={() => {
                if (pending) return;
                onConfirm();
              }}
            >
              {confirmLabel}
            </Button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
