import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it } from "vitest";

import { ScreenTitle } from "./screen-title";
import { ShellLayout } from "./shell-layout";

function TestPage({ title }: { title: string }) {
  return (
    <div>
      <ScreenTitle>{title}</ScreenTitle>
      <p>Content for {title}</p>
    </div>
  );
}

describe("ShellLayout", () => {
  it("renders top bar with screen title, updates document.title, and handles drawer navigation", async () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route element={<ShellLayout />}>
            <Route index element={<TestPage title="Test Title" />} />
            <Route path="settings/general" element={<TestPage title="General Settings" />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    const headings = screen.getAllByRole("heading", { level: 1 });
    expect(headings).toHaveLength(1);
    expect(headings[0]?.textContent).toBe("Test Title");
    expect(document.title).toBe("Test Title · Community Hub");

    // Open drawer
    const menuBtn = screen.getByRole("button", { name: "Open menu" });
    fireEvent.click(menuBtn);

    const dialog = screen.getByRole("dialog", { name: "Menu" });
    expect(dialog).toBeTruthy();

    // Navigate to General Settings inside drawer
    const link = within(dialog).getByRole("link", { name: "General Settings" });
    fireEvent.click(link);

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("General Settings");
    expect(document.title).toBe("General Settings · Community Hub");
  });
});
