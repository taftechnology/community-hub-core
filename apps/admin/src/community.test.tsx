import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CommunityProvider, useCommunity } from "./community";

const COMMUNITY_KEY = "community-hub.community";

function TestConsumer() {
  const { slug, version, setSlug } = useCommunity();
  return (
    <div>
      <span data-testid="slug-display">{slug || "no-slug"}</span>
      <span data-testid="version-display">{version}</span>
      <button type="button" onClick={() => setSlug("cathedral")}>
        Set Cathedral
      </button>
      <button type="button" onClick={() => setSlug("")}>
        Clear Slug
      </button>
    </div>
  );
}

describe("Community context and sessionStorage persistence", () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it("reads initial slug from sessionStorage and updates sessionStorage on setSlug", () => {
    sessionStorage.setItem(COMMUNITY_KEY, "parish");
    const { unmount } = render(
      <CommunityProvider>
        <TestConsumer />
      </CommunityProvider>,
    );

    expect(screen.getByTestId("slug-display").textContent).toBe("parish");

    fireEvent.click(screen.getByRole("button", { name: "Set Cathedral" }));
    expect(screen.getByTestId("slug-display").textContent).toBe("cathedral");
    expect(sessionStorage.getItem(COMMUNITY_KEY)).toBe("cathedral");

    unmount();

    // Remount within the same sessionStorage preserves the slug
    render(
      <CommunityProvider>
        <TestConsumer />
      </CommunityProvider>,
    );
    expect(screen.getByTestId("slug-display").textContent).toBe("cathedral");
  });

  it("increments version on setSlug even when slug is unchanged", () => {
    render(
      <CommunityProvider>
        <TestConsumer />
      </CommunityProvider>,
    );

    expect(screen.getByTestId("version-display").textContent).toBe("0");
    fireEvent.click(screen.getByRole("button", { name: "Set Cathedral" }));
    expect(screen.getByTestId("version-display").textContent).toBe("1");
    fireEvent.click(screen.getByRole("button", { name: "Set Cathedral" }));
    expect(screen.getByTestId("version-display").textContent).toBe("2");
  });

  it("handles a throwing sessionStorage on initial read with no slug and no crash", () => {
    vi.stubGlobal("sessionStorage", {
      getItem: () => {
        throw new Error("storage access denied");
      },
      setItem: () => {
        throw new Error("storage access denied");
      },
      clear: () => {},
    });

    render(
      <CommunityProvider>
        <TestConsumer />
      </CommunityProvider>,
    );

    expect(screen.getByTestId("slug-display").textContent).toBe("no-slug");
  });

  it("handles a throwing sessionStorage on write without crashing and preserves in-memory slug", () => {
    vi.stubGlobal("sessionStorage", {
      getItem: () => {
        throw new Error("storage access denied");
      },
      setItem: () => {
        throw new Error("storage access denied");
      },
      clear: () => {},
    });

    render(
      <CommunityProvider>
        <TestConsumer />
      </CommunityProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Set Cathedral" }));
    expect(screen.getByTestId("slug-display").textContent).toBe("cathedral");
  });

  it("survives a route change within the shell", async () => {
    sessionStorage.setItem(COMMUNITY_KEY, "parish");
    const { router, Shell } = await import("./shell");
    await router.navigate("/");
    render(<Shell />);

    expect((screen.getByRole("textbox", { name: "Community" }) as HTMLInputElement).value).toBe(
      "parish",
    );

    await router.navigate("/settings/users");
    expect((screen.getByRole("textbox", { name: "Community" }) as HTMLInputElement).value).toBe(
      "parish",
    );
  });
});
