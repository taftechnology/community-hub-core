import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { UserMenu } from "./user-menu";

describe("UserMenu", () => {
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
});
