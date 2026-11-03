import { fireEvent, render, screen } from "@testing-library/react";
import { TopBar } from "@community-hub/ui";
import { useRef } from "react";
import { describe, expect, it } from "vitest";

import { ScreenTitle, ScreenTitleProvider, useScreenTitleContext } from "./screen-title";

function InsideProviderHarness({
  headingRef,
}: {
  headingRef: React.RefObject<HTMLHeadingElement | null>;
}) {
  const context = useScreenTitleContext();
  if (!context) {
    throw new Error("missing context");
  }
  return (
    <div>
      <TopBar title={context.title} titleRef={context.titleRef} />
      <main>
        <ScreenTitle ref={headingRef}>Inside Provider Title</ScreenTitle>
      </main>
    </div>
  );
}

function StandaloneHarness({
  headingRef,
}: {
  headingRef: React.RefObject<HTMLHeadingElement | null>;
}) {
  return (
    <div>
      <ScreenTitle ref={headingRef}>Standalone Title</ScreenTitle>
      <button type="button" onClick={() => headingRef.current?.focus()}>
        Focus
      </button>
    </div>
  );
}

describe("ScreenTitle", () => {
  it("inside the provider, renders nothing, sets the TopBar title, and forwarded ref focuses the TopBar h1", () => {
    let headingRefCapture: React.RefObject<HTMLHeadingElement | null> = {
      current: null,
    };

    function Wrapper() {
      const headingRef = useRef<HTMLHeadingElement>(null);
      headingRefCapture = headingRef;
      return (
        <ScreenTitleProvider>
          <InsideProviderHarness headingRef={headingRef} />
        </ScreenTitleProvider>
      );
    }

    render(<Wrapper />);

    const headings = screen.getAllByRole("heading", { level: 1 });
    expect(headings).toHaveLength(1);
    expect(headings[0]?.textContent).toBe("Inside Provider Title");

    headingRefCapture.current?.focus();
    expect(document.activeElement).toBe(headings[0]);
  });

  it("with no provider, renders an h1 with tabIndex=-1 and forwarded ref focuses it", () => {
    function Wrapper() {
      const headingRef = useRef<HTMLHeadingElement>(null);
      return <StandaloneHarness headingRef={headingRef} />;
    }

    render(<Wrapper />);

    const heading = screen.getByRole("heading", {
      level: 1,
      name: "Standalone Title",
    });
    expect(heading).toBeTruthy();
    expect(heading.getAttribute("tabindex")).toBe("-1");

    fireEvent.click(screen.getByRole("button", { name: "Focus" }));
    expect(document.activeElement).toBe(heading);
  });
});
