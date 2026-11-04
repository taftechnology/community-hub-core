import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AppShell } from "./app-shell";

describe("AppShell", () => {
  it("renders sidebar, topBar, main and optional drawer slots", () => {
    render(
      <AppShell
        sidebar={<div data-testid="sidebar-content">Sidebar Content</div>}
        topBar={<div data-testid="topbar-content">TopBar Content</div>}
        drawer={<div data-testid="drawer-content">Drawer Content</div>}
      >
        <div data-testid="main-content">Page Content</div>
      </AppShell>,
    );

    expect(screen.getByTestId("sidebar-content")).toBeTruthy();
    expect(screen.getByTestId("topbar-content")).toBeTruthy();
    expect(screen.getByTestId("drawer-content")).toBeTruthy();
    expect(screen.getByTestId("main-content")).toBeTruthy();

    const main = screen.getByRole("main");
    expect(main).toBeTruthy();
    expect(main.contains(screen.getByTestId("main-content"))).toBe(true);
  });

  it("carries classes that hide sidebar below lg and on print", () => {
    const { container } = render(
      <AppShell sidebar={<div>Sidebar</div>} topBar={<div>TopBar</div>}>
        <div>Content</div>
      </AppShell>,
    );

    const sidebarSlot = container.querySelector("[data-slot='sidebar']");
    expect(sidebarSlot).not.toBeNull();
    expect(sidebarSlot?.className).toContain("hidden");
    expect(sidebarSlot?.className).toContain("lg:block");
    expect(sidebarSlot?.className).toContain("print:hidden");

    const topBarSlot = container.querySelector("[data-slot='top-bar']");
    expect(topBarSlot).not.toBeNull();
    expect(topBarSlot?.className).toContain("print:hidden");
  });

  it("applies responsive padding to main content", () => {
    const { container } = render(
      <AppShell sidebar={<div>Sidebar</div>} topBar={<div>TopBar</div>}>
        <div>Content</div>
      </AppShell>,
    );

    const main = container.querySelector("main");
    expect(main).not.toBeNull();
    expect(main?.className).toContain("p-(--ch-space-4)");
    expect(main?.className).toContain("lg:p-(--ch-space-6)");
    expect(main?.className).toContain("overflow-auto");
  });
});
