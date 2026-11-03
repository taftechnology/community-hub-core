import * as React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { TopBar } from "./top-bar";

describe("TopBar", () => {
  it("renders exactly one h1 with the title and tabIndex=-1", () => {
    const { container } = render(<TopBar title="Dashboard" />);
    const h1s = container.querySelectorAll("h1");
    expect(h1s).toHaveLength(1);
    expect(h1s[0]?.textContent).toBe("Dashboard");
    expect(h1s[0]?.getAttribute("tabindex")).toBe("-1");
  });

  it("attaches titleRef to the h1 element", () => {
    let capturedRef: HTMLHeadingElement | null = null;
    function TestWrapper() {
      const ref = React.useRef<HTMLHeadingElement>(null);
      React.useEffect(() => {
        capturedRef = ref.current;
      }, []);
      return <TopBar title="Dashboard" titleRef={ref} />;
    }

    render(<TestWrapper />);
    expect(capturedRef).not.toBeNull();
    expect(capturedRef?.tagName).toBe("H1");
    expect(capturedRef?.textContent).toBe("Dashboard");
  });

  it("renders menu button only when onMenu is provided", async () => {
    const onMenu = vi.fn();
    const { rerender } = render(<TopBar title="Dashboard" />);
    expect(screen.queryByRole("button", { name: "Open menu" })).toBeNull();

    rerender(<TopBar title="Dashboard" onMenu={onMenu} menuOpen={false} />);
    const menuBtn = screen.getByRole("button", { name: "Open menu" });
    expect(menuBtn).toBeTruthy();
    expect(menuBtn.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(menuBtn);
    expect(onMenu).toHaveBeenCalledTimes(1);

    rerender(<TopBar title="Dashboard" onMenu={onMenu} menuOpen={true} />);
    expect(menuBtn.getAttribute("aria-expanded")).toBe("true");
  });

  it("renders back link only when backHref is set", () => {
    const { rerender } = render(<TopBar title="Contact Details" />);
    expect(screen.queryByLabelText("Back")).toBeNull();

    rerender(
      <TopBar
        title="Contact Details"
        backHref="/contacts"
        backLabel="Back to contacts"
        renderLink={(item, props) => (
          <a href={item.href} {...props}>
            <span className="sr-only">{item.label}</span>
          </a>
        )}
      />,
    );

    const backLink = screen.getByRole("link", { name: "Back to contacts" });
    expect(backLink).toBeTruthy();
    expect(backLink.getAttribute("href")).toBe("/contacts");
  });

  it("renders actions slot when provided", () => {
    render(<TopBar title="Dashboard" actions={<button type="button">Theme</button>} />);

    expect(screen.getByRole("button", { name: "Theme" })).toBeTruthy();
  });
});
