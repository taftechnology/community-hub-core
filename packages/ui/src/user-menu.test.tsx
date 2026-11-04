import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { UserMenu, UserMenuCheckboxItem } from "./user-menu";

describe("UserMenu", () => {
  afterEach(() => {
    delete document.documentElement.dataset.theme;
  });

  it("signed out: renders one link 'Sign in' to signInHref, no Account button, no Sign out", () => {
    const onSignOut = vi.fn();
    render(<UserMenu signedIn={false} signInHref="/sign-in" onSignOut={onSignOut} />);

    const link = screen.getByRole("link", { name: "Sign in" });
    expect(link).not.toBeNull();
    expect(link.getAttribute("href")).toBe("/sign-in");

    expect(screen.queryByRole("button", { name: "Account" })).toBeNull();
    expect(screen.queryByText("Sign out")).toBeNull();
  });

  it("signed out: supports renderLink prop", () => {
    const renderLink = vi.fn(({ href, label }, props) => (
      <a href={href} {...props} data-custom-link="true">
        {label}
      </a>
    ));

    render(
      <UserMenu
        signedIn={false}
        signInHref="/sign-in"
        onSignOut={() => {}}
        renderLink={renderLink}
      />,
    );

    const link = screen.getByRole("link", { name: "Sign in" });
    expect(link.getAttribute("data-custom-link")).toBe("true");
    expect(renderLink).toHaveBeenCalledTimes(1);
  });

  it("signed in: opening menu shows 'Sign out', clicking calls onSignOut once", async () => {
    const onSignOut = vi.fn();
    render(<UserMenu signedIn={true} signInHref="/sign-in" onSignOut={onSignOut} />);

    const trigger = screen.getByRole("button", { name: "Account" });
    expect(trigger).not.toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Sign out" })).toBeNull();

    fireEvent.click(trigger);

    const signOutItem = await screen.findByRole("menuitem", { name: "Sign out" });
    expect(signOutItem).not.toBeNull();
    expect(signOutItem.className).toContain("text-destructive-ink");

    fireEvent.click(signOutItem);
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });

  it("carries touch:min-h-(--ch-size-touch) on UserMenuCheckboxItem and Sign out", async () => {
    render(
      <UserMenu
        signedIn={true}
        signInHref="/sign-in"
        onSignOut={() => {}}
        extraItems={
          <UserMenuCheckboxItem checked={false} onCheckedChange={() => {}}>
            Dark mode
          </UserMenuCheckboxItem>
        }
      />,
    );

    const trigger = screen.getByRole("button", { name: "Account" });
    fireEvent.click(trigger);

    const darkModeItem = await screen.findByRole("menuitemcheckbox", { name: "Dark mode" });
    expect(darkModeItem.className).toContain("touch:min-h-(--ch-size-touch)");

    const signOutItem = screen.getByRole("menuitem", { name: "Sign out" });
    expect(signOutItem.className).toContain("touch:min-h-(--ch-size-touch)");
  });

  it("closes on Escape and returns focus to the Account trigger", async () => {
    render(<UserMenu signedIn={true} signInHref="/sign-in" onSignOut={() => {}} />);

    const trigger = screen.getByRole("button", { name: "Account" });
    fireEvent.click(trigger);

    const signOutItem = await screen.findByRole("menuitem", { name: "Sign out" });
    expect(signOutItem).not.toBeNull();

    fireEvent.keyDown(signOutItem, { key: "Escape" });

    await waitFor(() => {
      expect(screen.queryByRole("menuitem", { name: "Sign out" })).toBeNull();
    });
    expect(document.activeElement).toBe(trigger);
  });

  it("renders extraItems inside menu above Sign out", async () => {
    render(
      <UserMenu
        signedIn={true}
        signInHref="/sign-in"
        onSignOut={() => {}}
        extraItems={<span data-testid="extra-theme-toggle">Theme Option</span>}
      />,
    );

    const trigger = screen.getByRole("button", { name: "Account" });
    fireEvent.click(trigger);

    const extra = await screen.findByTestId("extra-theme-toggle");
    expect(extra).not.toBeNull();

    const signOut = screen.getByRole("menuitem", { name: "Sign out" });
    expect(signOut).not.toBeNull();

    // extraItems precedes Sign out in the DOM
    expect(extra.compareDocumentPosition(signOut) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("does not render Profile or Help text anywhere", async () => {
    const { container } = render(
      <UserMenu signedIn={true} signInHref="/sign-in" onSignOut={() => {}} />,
    );

    const trigger = screen.getByRole("button", { name: "Account" });
    fireEvent.click(trigger);
    await screen.findByRole("menuitem", { name: "Sign out" });

    expect(container.textContent).not.toMatch(/profile/i);
    expect(container.textContent).not.toMatch(/help/i);
    expect(document.body.textContent).not.toMatch(/profile/i);
    expect(document.body.textContent).not.toMatch(/help/i);
  });

  it("navigates to UserMenuCheckboxItem with ArrowDown, toggles on Enter, and navigates to Sign out", async () => {
    const onCheckedChange = vi.fn();
    render(
      <UserMenu
        signedIn={true}
        signInHref="/sign-in"
        onSignOut={() => {}}
        extraItems={
          <UserMenuCheckboxItem checked={false} onCheckedChange={onCheckedChange}>
            Dark mode
          </UserMenuCheckboxItem>
        }
      />,
    );

    const trigger = screen.getByRole("button", { name: "Account" });
    fireEvent.click(trigger);

    const darkModeItem = await screen.findByRole("menuitemcheckbox", { name: "Dark mode" });
    expect(darkModeItem).not.toBeNull();
    expect(darkModeItem.getAttribute("aria-checked")).toBe("false");

    const popup = screen.getByRole("menu");

    // Press ArrowDown until "Dark mode" has focus or is highlighted (base-ui sets data-highlighted)
    while (
      !darkModeItem.hasAttribute("data-highlighted") &&
      document.activeElement !== darkModeItem
    ) {
      fireEvent.keyDown(document.activeElement ?? popup, { key: "ArrowDown" });
    }

    expect(
      darkModeItem.hasAttribute("data-highlighted") || document.activeElement === darkModeItem,
    ).toBe(true);

    fireEvent.keyDown(darkModeItem, { key: "Enter" });
    expect(onCheckedChange).toHaveBeenCalledTimes(1);
    expect(onCheckedChange).toHaveBeenCalledWith(true);

    // ArrowDown again reaches "Sign out"
    const signOutItem = screen.getByRole("menuitem", { name: "Sign out" });
    fireEvent.keyDown(darkModeItem, { key: "ArrowDown" });
    expect(
      signOutItem.hasAttribute("data-highlighted") || document.activeElement === signOutItem,
    ).toBe(true);
  });

  for (const theme of ["light", "dark"] as const) {
    it(`passes axe with no violations in ${theme} mode when UserMenuCheckboxItem is present`, async () => {
      document.documentElement.dataset.theme = theme;
      const { container } = render(
        <UserMenu
          signedIn={true}
          signInHref="/sign-in"
          onSignOut={() => {}}
          extraItems={
            <UserMenuCheckboxItem checked={theme === "dark"} onCheckedChange={() => {}}>
              Dark mode
            </UserMenuCheckboxItem>
          }
        />,
      );

      const trigger = screen.getByRole("button", { name: "Account" });
      fireEvent.click(trigger);

      const popup = await screen.findByRole("menu");
      const results = await axe.run([container, popup], {
        rules: {
          "color-contrast": { enabled: false },
        },
      });
      expect(results.violations).toEqual([]);
    });
  }
});
