import * as React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ConfirmDialog, type ConfirmDialogProps } from "./confirm-dialog";

type Overrides = Partial<Pick<ConfirmDialogProps, "pending" | "error" | "tone">> & {
  onConfirm?: () => void;
  onOpenChange?: (open: boolean) => void;
};

function descriptionOf(element: HTMLElement): string {
  const id = element.getAttribute("aria-describedby") ?? "";
  return document.getElementById(id)?.textContent ?? "";
}

function Harness({ onConfirm, onOpenChange, ...rest }: Overrides) {
  const [open, setOpen] = React.useState(false);
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      <ConfirmDialog
        open={open}
        onOpenChange={(next) => {
          onOpenChange?.(next);
          setOpen(next);
        }}
        title="Delete Alex Example?"
        description="They are hidden now."
        confirmLabel="Delete"
        cancelLabel="Keep"
        onConfirm={() => {
          onConfirm?.();
          // The caller closes the dialog once its work is done.
          setOpen(false);
        }}
        {...rest}
      />
    </div>
  );
}

function staticProps(overrides: Partial<ConfirmDialogProps> = {}): ConfirmDialogProps {
  return {
    open: true,
    onOpenChange: () => {},
    title: "Delete Alex Example?",
    description: "They are hidden now.",
    confirmLabel: "Delete",
    cancelLabel: "Keep",
    onConfirm: () => {},
    ...overrides,
  };
}

describe("ConfirmDialog", () => {
  it("renders the title, the description and both buttons", () => {
    render(<ConfirmDialog {...staticProps()} />);
    const dialog = screen.getByRole("dialog", { name: "Delete Alex Example?" });
    expect(descriptionOf(dialog)).toBe("They are hidden now.");
    expect(screen.getByRole("button", { name: "Delete" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Keep" })).toBeTruthy();
  });

  it("renders nothing while closed", () => {
    render(<ConfirmDialog {...staticProps({ open: false })} />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("calls onConfirm once, and nothing more while pending", () => {
    const onConfirm = vi.fn();
    const { rerender } = render(<ConfirmDialog {...staticProps({ onConfirm })} />);
    const confirm = screen.getByRole("button", { name: "Delete" });
    expect(confirm.getAttribute("aria-busy")).not.toBe("true");

    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);

    rerender(<ConfirmDialog {...staticProps({ onConfirm, pending: true })} />);
    const busy = screen.getByRole("button", { name: "Delete" });
    expect(busy.getAttribute("aria-busy")).toBe("true");
    fireEvent.click(busy);
    fireEvent.click(busy);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("shows the error line when given and announces it", () => {
    render(
      <ConfirmDialog
        {...staticProps({ error: "This contact was changed. Reload and try again." })}
      />,
    );
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("This contact was changed. Reload and try again.");
  });

  it("shows no error line when none is given", () => {
    render(<ConfirmDialog {...staticProps()} />);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("styles the confirm button as destructive for the danger tone only", () => {
    const { unmount } = render(<ConfirmDialog {...staticProps({ tone: "danger" })} />);
    expect(screen.getByRole("button", { name: "Delete" }).className).toContain("bg-destructive");
    unmount();
    render(<ConfirmDialog {...staticProps({ tone: "default" })} />);
    const plain = screen.getByRole("button", { name: "Delete" });
    expect(plain.className).not.toContain("bg-destructive");
    expect(plain.className).toContain("bg-primary");
  });

  it("ConfirmDialog returns focus to the trigger on cancel and on confirm", async () => {
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Open" });

    for (const label of ["Keep", "Delete"]) {
      trigger.focus();
      fireEvent.click(trigger);
      const dialog = await screen.findByRole("dialog");
      await waitFor(() => {
        expect(dialog.contains(document.activeElement)).toBe(true);
      });

      fireEvent.click(screen.getByRole("button", { name: label }));
      await waitFor(() => {
        expect(screen.queryByRole("dialog")).toBeNull();
        expect(document.activeElement).toBe(trigger);
      });
    }
  });

  it("ConfirmDialog does not confirm on Escape or Cancel", async () => {
    const onConfirm = vi.fn();
    const onOpenChange = vi.fn();
    render(<Harness onConfirm={onConfirm} onOpenChange={onOpenChange} />);

    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    fireEvent.keyDown(await screen.findByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(onOpenChange).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    expect(onConfirm).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    fireEvent.click(await screen.findByRole("button", { name: "Keep" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(onOpenChange).toHaveBeenCalledTimes(2);
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
