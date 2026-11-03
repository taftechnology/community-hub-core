import * as React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Drawer } from "./drawer";

function DrawerHarness({ initialOpen = false }: { initialOpen?: boolean }) {
  const [open, setOpen] = React.useState(initialOpen);
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>
        Open Drawer
      </button>
      <Drawer open={open} onOpenChange={setOpen} label="Menu">
        <div>
          <a href="/link1">Link 1</a>
          <a href="/link2">Link 2</a>
        </div>
      </Drawer>
    </div>
  );
}

describe("Drawer", () => {
  it("focuses inside the drawer on opening and keeps Tab / Shift-Tab inside", async () => {
    render(<DrawerHarness initialOpen={false} />);

    const openButton = screen.getByRole("button", { name: "Open Drawer" });
    openButton.focus();
    expect(document.activeElement).toBe(openButton);

    fireEvent.click(openButton);

    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeTruthy();

    // Focus moves inside the dialog on open
    await waitFor(() => {
      expect(dialog.contains(document.activeElement)).toBe(true);
    });

    // Tab keydown events within the dialog stay contained
    fireEvent.keyDown(document.activeElement ?? dialog, { key: "Tab" });
    expect(dialog.contains(document.activeElement)).toBe(true);

    fireEvent.keyDown(document.activeElement ?? dialog, { key: "Tab", shiftKey: true });
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("calls onOpenChange(false) on Escape", () => {
    const onOpenChange = vi.fn();

    render(
      <Drawer open={true} onOpenChange={onOpenChange} label="Menu">
        <div>Content</div>
      </Drawer>,
    );

    const dialog = screen.getByRole("dialog");
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onOpenChange).toHaveBeenCalledWith(false, expect.anything());
  });

  it("returns focus to the opener button after closing", async () => {
    render(<DrawerHarness initialOpen={false} />);

    const openButton = screen.getByRole("button", { name: "Open Drawer" });
    openButton.focus();
    expect(document.activeElement).toBe(openButton);

    fireEvent.click(openButton);

    const closeButton = screen.getByRole("button", { name: "Close menu" });
    expect(closeButton).toBeTruthy();

    fireEvent.click(closeButton);

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(document.activeElement).toBe(openButton);
    });
  });
});
