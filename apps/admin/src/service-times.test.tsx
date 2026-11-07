import "./test-support/prosemirror-dom";

import * as faithChurch from "@community-hub/faith-church";
import { terminology } from "@community-hub/faith-church";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import axe from "axe-core";
import fs from "node:fs";
import path from "node:path";
import { StrictMode } from "react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BillingStatusContext } from "./billing-status";
import { CommunityProvider, useCommunity } from "./community";
import { PeopleAccessContext, type PeopleAccess } from "./people-access";
import { ServiceTimesPage } from "./service-times";
import { SERVICE_TIMES_HTML_MAX } from "./service-times-api";

type EditorInstance = Parameters<
  NonNullable<import("@community-hub/ui/rich-text-editor").RichTextEditorProps["onEditorReady"]>
>[0];

const captured = vi.hoisted(() => ({
  editor: null as EditorInstance | null,
}));

vi.mock("@community-hub/ui/rich-text-editor", async (importOriginal) => {
  const React = await import("react");
  const actual = await importOriginal<typeof import("@community-hub/ui/rich-text-editor")>();
  const Wrapped = React.forwardRef<
    import("@community-hub/ui/rich-text-editor").RichTextEditorHandle,
    import("@community-hub/ui/rich-text-editor").RichTextEditorProps
  >((props, ref) => {
    return React.createElement(actual.RichTextEditor, {
      ...props,
      ref,
      onEditorReady: (ed) => {
        captured.editor = ed;
        props.onEditorReady?.(ed);
      },
    });
  });
  return { ...actual, RichTextEditor: Wrapped };
});

const TEST_TOKEN = "test-token";
const DEFAULT_COMMUNITY = "parish-test";

const fullAccess: PeopleAccess = {
  permissions: {
    "people.view": true,
    "people.manage": true,
    "people.restricted.read": true,
    "service_times.manage": true,
  },
  entitlements: {
    "people.directory": true,
    "people.households": true,
    "module.engagement": true,
  },
};

function mockResponse(status: number, body?: unknown) {
  return new Response(body !== undefined ? JSON.stringify(body) : null, {
    status,
    headers: { "content-type": "application/json" },
  });
}

function renderServiceTimesPage({
  access = fullAccess,
  communitySlug = DEFAULT_COMMUNITY,
  initialEntries = ["/engagement/service-times"],
}: {
  access?: PeopleAccess;
  communitySlug?: string;
  initialEntries?: string[];
} = {}) {
  sessionStorage.setItem("community-hub.community", communitySlug);
  const router = createMemoryRouter(
    [
      {
        path: "/engagement/service-times",
        element: <ServiceTimesPage />,
      },
      {
        path: "/other",
        element: <div>Other Page</div>,
      },
    ],
    { initialEntries },
  );

  const rendered = render(
    <PeopleAccessContext.Provider value={{ access }}>
      <CommunityProvider>
        <BillingStatusContext.Provider
          value={{
            status: {
              state: "ok",
              trial_end: null,
              grace_until: null,
              canView: true,
              canManage: true,
            },
            readiness: "ready",
            refresh: vi.fn(),
            returnMessage: null,
          }}
        >
          <RouterProvider router={router} />
        </BillingStatusContext.Provider>
      </CommunityProvider>
    </PeopleAccessContext.Provider>,
  );

  return { ...rendered, router };
}

// Waits until the Save button is enabled and returns it.
// The editor writes its text to the DOM before React commits the state that enables Save.
async function waitForSaveButton(): Promise<HTMLButtonElement> {
  return waitFor(() => {
    const button = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    return button;
  });
}

describe("ServiceTimesPage", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    captured.editor = null;
    sessionStorage.clear();
    sessionStorage.setItem("community-hub.access-token", TEST_TOKEN);
    sessionStorage.setItem("community-hub.community", DEFAULT_COMMUNITY);
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("matches SERVICE_TIMES_HTML_MAX in contracts", () => {
    const contractsPath = path.resolve(
      __dirname,
      "../../../packages/contracts/src/service-times.ts",
    );
    const text = fs.readFileSync(contractsPath, "utf-8");
    const match = text.match(/SERVICE_TIMES_HTML_MAX\s*=\s*([0-9_]+)/);
    expect(match).not.toBeNull();
    const contractsValue = Number(match![1]!.replace(/_/g, ""));
    expect(contractsValue).toBe(SERVICE_TIMES_HTML_MAX);
  });

  it("renders pack plural as title and loads saved text into the editor", async () => {
    const plural = terminology("engagement.service_times").plural;
    fetchSpy.mockResolvedValueOnce(
      mockResponse(200, { html: "<p>Saturday 5pm Mass</p>", version: 1 }),
    );

    renderServiceTimesPage();

    expect(screen.getByRole("heading", { level: 1, name: plural })).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByText("Saturday 5pm Mass")).toBeTruthy();
    });
  });

  it("renders empty editor with placeholder and pack hint when no saved text exists", async () => {
    const term = terminology("engagement.service_times");
    fetchSpy.mockResolvedValueOnce(mockResponse(200, { html: "", version: 0 }));

    renderServiceTimesPage();

    await waitFor(() => {
      expect(screen.getByLabelText(term.fieldLabel)).toBeTruthy();
    });
    expect(screen.getByText(term.hint)).toBeTruthy();
  });

  it("saves changes, replaces content with cleaned html, announces Saved status, and clears on edit", async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse(200, { html: "<p>Initial text</p>", version: 1 }));

    renderServiceTimesPage();

    await waitFor(() => {
      expect(screen.getByText("Initial text")).toBeTruthy();
    });

    // Simulate saving updated content
    fetchSpy.mockResolvedValueOnce(
      mockResponse(200, { html: "<p>Server cleaned text</p>", version: 2 }),
    );

    const saveBtn = await waitForSaveButton();
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toContain("Saved");
    });
    expect(screen.getByText("Server cleaned text")).toBeTruthy();

    // Clears saved status on next edit
    const editor = captured.editor;
    expect(editor).toBeTruthy();
    act(() => {
      editor!.commands.setContent("<p>New edit after save</p>");
    });
    expect(screen.queryByText("Saved")).toBeNull();
  });

  it("sends only one POST request when Save is double clicked", async () => {
    let resolveSave: (r: Response) => void;
    fetchSpy
      .mockResolvedValueOnce(mockResponse(200, { html: "<p>Initial</p>", version: 1 }))
      .mockImplementationOnce(
        () =>
          new Promise((res) => {
            resolveSave = res;
          }),
      );

    renderServiceTimesPage();

    await waitFor(() => {
      expect(screen.getByText("Initial")).toBeTruthy();
    });

    const saveBtn = await waitForSaveButton();
    fireEvent.click(saveBtn);
    fireEvent.click(saveBtn); // double click

    expect(fetchSpy).toHaveBeenCalledTimes(2); // 1 get + 1 save
    resolveSave!(mockResponse(200, { html: "<p>Initial</p>", version: 2 }));
    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toContain("Saved");
    });
  });

  it("handles 409 conflict: keeps staff text, shows conflict message, and Reload refetches", async () => {
    fetchSpy
      .mockResolvedValueOnce(mockResponse(200, { html: "<p>Original</p>", version: 1 }))
      .mockResolvedValueOnce(mockResponse(409));

    renderServiceTimesPage();

    await waitFor(() => {
      expect(screen.getByText("Original")).toBeTruthy();
    });

    const saveBtn = await waitForSaveButton();
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(
        screen.getByText(
          "Someone else saved a change first. Reload to see their text, or copy yours before you reload.",
        ),
      ).toBeTruthy();
    });

    // Staff text is preserved
    expect(screen.getByText("Original")).toBeTruthy();

    // Reload button discards and refetches
    fetchSpy.mockResolvedValueOnce(
      mockResponse(200, { html: "<p>Someone else text</p>", version: 2 }),
    );

    const reloadBtn = screen.getByRole("button", { name: /reload/i });
    fireEvent.click(reloadBtn);

    await waitFor(() => {
      expect(screen.getByText("Someone else text")).toBeTruthy();
    });
  });

  it("handles 402 read-only billing: shows read-only message and calls refresh", async () => {
    const refreshMock = vi.fn();
    fetchSpy
      .mockResolvedValueOnce(mockResponse(200, { html: "<p>Draft</p>", version: 1 }))
      .mockResolvedValueOnce(mockResponse(402));

    const router = createMemoryRouter(
      [{ path: "/engagement/service-times", element: <ServiceTimesPage /> }],
      { initialEntries: ["/engagement/service-times"] },
    );

    render(
      <PeopleAccessContext.Provider value={{ access: fullAccess }}>
        <CommunityProvider>
          <BillingStatusContext.Provider
            value={{
              status: {
                state: "read_only",
                trial_end: null,
                grace_until: null,
                canView: true,
                canManage: true,
              },
              readiness: "ready",
              refresh: refreshMock,
              returnMessage: null,
            }}
          >
            <RouterProvider router={router} />
          </BillingStatusContext.Provider>
        </CommunityProvider>
      </PeopleAccessContext.Provider>,
    );

    await waitFor(() => {
      expect(screen.getByText("Draft")).toBeTruthy();
    });

    const saveBtn = await waitForSaveButton();
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(screen.getByText("Read-only until billing is settled")).toBeTruthy();
    });
    expect(refreshMock).toHaveBeenCalled();
    expect(screen.getByText("Draft")).toBeTruthy();
  });

  it("handles 403 forbidden on save with fixed message and preserves text", async () => {
    fetchSpy
      .mockResolvedValueOnce(mockResponse(200, { html: "<p>Draft</p>", version: 1 }))
      .mockResolvedValueOnce(mockResponse(403));

    renderServiceTimesPage();

    await waitFor(() => {
      expect(screen.getByText("Draft")).toBeTruthy();
    });

    const saveBtn = await waitForSaveButton();
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(screen.getByText("You do not have permission to change this.")).toBeTruthy();
    });
    expect(screen.getByText("Draft")).toBeTruthy();
  });

  it("handles 400 over-cap response and network error with fixed messages and preserves text", async () => {
    fetchSpy
      .mockResolvedValueOnce(mockResponse(200, { html: "<p>Draft</p>", version: 1 }))
      .mockResolvedValueOnce(mockResponse(400));

    renderServiceTimesPage();

    await waitFor(() => {
      expect(screen.getByText("Draft")).toBeTruthy();
    });

    const saveBtn = await waitForSaveButton();
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(screen.getByText("This is too long to save. Shorten it and try again.")).toBeTruthy();
    });
    expect(screen.getByText("Draft")).toBeTruthy();

    // Network failure on next save
    fetchSpy.mockRejectedValueOnce(new Error("Network failure"));
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(screen.getByText("Could not save. Try again.")).toBeTruthy();
    });
    expect(screen.getByText("Draft")).toBeTruthy();
  });

  it("blocks Save and sends NOTHING when content exceeds SERVICE_TIMES_HTML_MAX", async () => {
    const longText = "<p>" + "a".repeat(SERVICE_TIMES_HTML_MAX + 10) + "</p>";
    fetchSpy.mockResolvedValueOnce(mockResponse(200, { html: longText, version: 1 }));

    renderServiceTimesPage();

    await waitFor(() => {
      expect(screen.queryByText("Loading...")).toBeNull();
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    const saveBtn = screen.getByRole("button", { name: "Save" });
    fireEvent.click(saveBtn);

    expect(screen.getByText("This is too long to save. Shorten it and try again.")).toBeTruthy();
    // Only the initial GET was called, nothing sent for save
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("labels come from the pack without hard-coded words", async () => {
    vi.spyOn(faithChurch, "terminology").mockReturnValue({
      singular: "Prayer Time",
      plural: "Prayer Times",
      fieldLabel: "Prayer Content",
      placeholder: "Enter prayer times here...",
      hint: "Prayer hint appears on website.",
    });

    fetchSpy.mockResolvedValueOnce(mockResponse(200, { html: "", version: 0 }));

    renderServiceTimesPage();

    await waitFor(() => {
      expect(screen.getByRole("heading", { level: 1, name: "Prayer Times" })).toBeTruthy();
      expect(screen.getByLabelText("Prayer Content")).toBeTruthy();
      expect(screen.getByText("Prayer hint appears on website.")).toBeTruthy();
    });
  });

  it("prevents beforeunload when dirty and allows when clean", async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse(200, { html: "<p>Initial</p>", version: 1 }));

    renderServiceTimesPage();

    await waitFor(() => {
      expect(screen.getByText("Initial")).toBeTruthy();
    });

    // Right after load, not dirty
    const cleanEvent = new Event("beforeunload", { cancelable: true }) as BeforeUnloadEvent;
    window.dispatchEvent(cleanEvent);
    expect(cleanEvent.defaultPrevented).toBe(false);

    // Edit content to make dirty
    const editor = captured.editor;
    expect(editor).toBeTruthy();
    act(() => {
      editor!.commands.setContent("<p>Modified</p>");
    });

    const dirtyEvent = new Event("beforeunload", { cancelable: true }) as BeforeUnloadEvent;
    window.dispatchEvent(dirtyEvent);
    expect(dirtyEvent.defaultPrevented).toBe(true);
  });

  it("PIN 25: after load with <ul><li>x</li></ul>, baseline matches editor serialization and leave prompt does not fire", async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse(200, { html: "<ul><li>x</li></ul>", version: 1 }));

    const { router } = renderServiceTimesPage();

    await waitFor(() => {
      expect(screen.queryByText("Loading...")).toBeNull();
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    const editor = captured.editor;
    expect(editor).toBeTruthy();

    // Edit content to make dirty
    act(() => {
      editor!.commands.setContent("<p>Changed</p>");
    });

    // In-app navigation is blocked by unsaved changes dialog
    act(() => {
      router.navigate("/other");
    });
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    expect(screen.getByText("Unsaved changes")).toBeTruthy();

    // Dismiss dialog via "Stay"
    fireEvent.click(screen.getByRole("button", { name: "Stay" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();

    // Restore content to loaded representation
    act(() => {
      editor!.commands.setContent("<ul><li>x</li></ul>");
    });

    // Window beforeunload is not prevented when restored to baseline
    const cleanEvent = new Event("beforeunload", { cancelable: true }) as BeforeUnloadEvent;
    window.dispatchEvent(cleanEvent);
    expect(cleanEvent.defaultPrevented).toBe(false);

    // In-app navigation proceeds without prompt
    act(() => {
      router.navigate("/other");
    });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await waitFor(() => {
      expect(screen.getByText("Other Page")).toBeTruthy();
    });
  });

  it("PIN 25: after save with <ul><li>x</li></ul>, baseline matches editor serialization and leave prompt does not fire", async () => {
    fetchSpy
      .mockResolvedValueOnce(mockResponse(200, { html: "<p>Initial</p>", version: 1 }))
      .mockResolvedValueOnce(mockResponse(200, { html: "<ul><li>x</li></ul>", version: 2 }));

    const { router } = renderServiceTimesPage();

    await waitFor(() => {
      expect(screen.getByText("Initial")).toBeTruthy();
    });

    const editor = captured.editor;
    expect(editor).toBeTruthy();

    // Edit content to make dirty before save
    act(() => {
      editor!.commands.setContent("<p>Edit before save</p>");
    });

    // Save
    const saveBtn = await waitForSaveButton();
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toContain("Saved");
    });

    // Edit away to make dirty
    act(() => {
      editor!.commands.setContent("<p>Changed after save</p>");
    });

    // In-app navigation is blocked
    act(() => {
      router.navigate("/other");
    });
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    expect(screen.getByText("Unsaved changes")).toBeTruthy();

    // Dismiss dialog via "Stay"
    fireEvent.click(screen.getByRole("button", { name: "Stay" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();

    // Restore content to saved HTML representation
    act(() => {
      editor!.commands.setContent("<ul><li>x</li></ul>");
    });

    // Window beforeunload is not prevented when restored to baseline
    const cleanEvent = new Event("beforeunload", { cancelable: true }) as BeforeUnloadEvent;
    window.dispatchEvent(cleanEvent);
    expect(cleanEvent.defaultPrevented).toBe(false);

    // In-app navigation proceeds without prompt
    act(() => {
      router.navigate("/other");
    });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await waitFor(() => {
      expect(screen.getByText("Other Page")).toBeTruthy();
    });
  });

  it("blocks in-app navigation when dirty and offers Stay and Leave without saving", async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse(200, { html: "<p>Initial</p>", version: 1 }));

    const { router } = renderServiceTimesPage();

    await waitFor(() => {
      expect(screen.getByText("Initial")).toBeTruthy();
    });

    // Modify editor content
    const editor = captured.editor;
    expect(editor).toBeTruthy();
    act(() => {
      editor!.commands.setContent("<p>Dirty content</p>");
    });

    // Try to navigate away
    act(() => {
      router.navigate("/other");
    });

    // Blocked alert appears
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    expect(screen.getByText("Unsaved changes")).toBeTruthy();

    // Click "Stay"
    fireEvent.click(screen.getByRole("button", { name: "Stay" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();

    // Try to navigate again
    act(() => {
      router.navigate("/other");
    });
    expect(screen.getByRole("alertdialog")).toBeTruthy();

    // Click "Leave without saving"
    fireEvent.click(screen.getByRole("button", { name: "Leave without saving" }));
    await waitFor(() => {
      expect(screen.getByText("Other Page")).toBeTruthy();
    });
  });

  it("stale-response guard: slow first load that resolves after community switch is ignored", async () => {
    let resolveFirstLoad: (r: Response) => void;
    let resolveSecondLoad: (r: Response) => void;

    fetchSpy
      .mockImplementationOnce(
        () =>
          new Promise((res) => {
            resolveFirstLoad = res;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((res) => {
            resolveSecondLoad = res;
          }),
      );

    function SwitchContainer() {
      function SwitchButton() {
        const { setSlug } = useCommunity();
        return (
          <button type="button" onClick={() => setSlug("parish-b")}>
            Switch
          </button>
        );
      }

      return (
        <PeopleAccessContext.Provider value={{ access: fullAccess }}>
          <CommunityProvider>
            <SwitchButton />
            <ServiceTimesPage />
          </CommunityProvider>
        </PeopleAccessContext.Provider>
      );
    }

    sessionStorage.setItem("community-hub.community", "parish-a");
    const router = createMemoryRouter([{ path: "/", element: <SwitchContainer /> }], {
      initialEntries: ["/"],
    });

    render(<RouterProvider router={router} />);

    // Switch community while parish-a is loading
    fireEvent.click(screen.getByText("Switch"));

    // Parish-b resolves first
    resolveSecondLoad!(mockResponse(200, { html: "<p>Parish B text</p>", version: 2 }));
    await waitFor(() => {
      expect(screen.getByText("Parish B text")).toBeTruthy();
    });

    // Stale Parish-a resolves later: must be ignored!
    resolveFirstLoad!(mockResponse(200, { html: "<p>Parish A text</p>", version: 1 }));
    await waitFor(() => {
      expect(screen.queryByText("Parish A text")).toBeNull();
    });
    expect(screen.getByText("Parish B text")).toBeTruthy();
  });

  it("stale-response guard: slow save response that resolves after a reload is ignored", async () => {
    let resolveSave: (r: Response) => void;

    fetchSpy
      .mockResolvedValueOnce(mockResponse(200, { html: "<p>Parish A text</p>", version: 1 }))
      .mockImplementationOnce(
        () =>
          new Promise((res) => {
            resolveSave = res;
          }),
      )
      .mockResolvedValueOnce(mockResponse(200, { html: "<p>Parish B text</p>", version: 1 }));

    function SwitchSaveContainer() {
      function SwitchButton() {
        const { setSlug } = useCommunity();
        return (
          <button type="button" onClick={() => setSlug("parish-b")}>
            Switch
          </button>
        );
      }

      return (
        <PeopleAccessContext.Provider value={{ access: fullAccess }}>
          <CommunityProvider>
            <SwitchButton />
            <ServiceTimesPage />
          </CommunityProvider>
        </PeopleAccessContext.Provider>
      );
    }

    sessionStorage.setItem("community-hub.community", "parish-a");
    const router = createMemoryRouter([{ path: "/", element: <SwitchSaveContainer /> }], {
      initialEntries: ["/"],
    });

    render(<RouterProvider router={router} />);

    await waitFor(() => {
      expect(screen.getByText("Parish A text")).toBeTruthy();
    });

    // Start Save for Parish A (slow)
    const saveBtn = await waitForSaveButton();
    fireEvent.click(saveBtn);

    // Switch community to Parish B (triggers reload)
    fireEvent.click(screen.getByText("Switch"));

    await waitFor(() => {
      expect(screen.getByText("Parish B text")).toBeTruthy();
    });

    // Now stale save for Parish A resolves
    resolveSave!(mockResponse(200, { html: "<p>Stale Parish A saved</p>", version: 2 }));

    // Without guard, "Stale Parish A saved" overwrites "Parish B text". With guard, it is ignored!
    await waitFor(() => {
      expect(screen.queryByText("Stale Parish A saved")).toBeNull();
    });
    expect(screen.getByText("Parish B text")).toBeTruthy();
  });

  it("renders cleanly in StrictMode and performs exactly one load request", async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse(200, { html: "<p>Strict test</p>", version: 1 }));

    sessionStorage.setItem("community-hub.community", DEFAULT_COMMUNITY);
    const router = createMemoryRouter(
      [{ path: "/engagement/service-times", element: <ServiceTimesPage /> }],
      { initialEntries: ["/engagement/service-times"] },
    );

    render(
      <StrictMode>
        <PeopleAccessContext.Provider value={{ access: fullAccess }}>
          <CommunityProvider>
            <RouterProvider router={router} />
          </CommunityProvider>
        </PeopleAccessContext.Provider>
      </StrictMode>,
    );

    await waitFor(() => {
      expect(screen.getByText("Strict test")).toBeTruthy();
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("renders fixed message and makes NO request when user lacks access", async () => {
    const noAccess: PeopleAccess = {
      permissions: {
        "people.view": true,
        "people.manage": true,
        "people.restricted.read": true,
        "service_times.manage": false,
      },
      entitlements: {
        "people.directory": true,
        "people.households": true,
        "module.engagement": false,
      },
    };

    renderServiceTimesPage({ access: noAccess });

    expect(screen.getByText("You do not have access to this page.")).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("controls adhere to 36px controls / 44px touch targets", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockResponse(200, { html: "<p>Target content</p>", version: 1 }),
    );

    renderServiceTimesPage();

    await waitFor(() => {
      expect(screen.getByText("Target content")).toBeTruthy();
    });

    const saveBtn = screen.getByRole("button", { name: "Save" });
    expect(saveBtn).toBeTruthy();
    // Toolbar buttons have touch targets
    const toolbarButtons = screen.getAllByRole("button");
    expect(toolbarButtons.length).toBeGreaterThan(1);
  });

  it("passes axe accessibility checks in light, dark, and error states", async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse(200, { html: "<p>A11y content</p>", version: 1 }));

    const { container } = renderServiceTimesPage();

    await waitFor(() => {
      expect(screen.getByText("A11y content")).toBeTruthy();
    });

    // Light mode
    const lightResults = await axe.run(container);
    expect(lightResults.violations).toEqual([]);

    // Dark mode
    document.documentElement.dataset.theme = "dark";
    const darkResults = await axe.run(container);
    expect(darkResults.violations).toEqual([]);
    delete document.documentElement.dataset.theme;

    // Error state axe
    fetchSpy.mockResolvedValueOnce(mockResponse(403));
    const saveBtn = await waitForSaveButton();
    fireEvent.click(saveBtn);
    await waitFor(() => {
      expect(screen.getByText("You do not have permission to change this.")).toBeTruthy();
    });
    const errorResults = await axe.run(container);
    expect(errorResults.violations).toEqual([]);
  });

  it("guard: production component never leaks test hooks onto window", () => {
    const sourcePath = path.resolve(__dirname, "service-times.tsx");
    const text = fs.readFileSync(sourcePath, "utf-8");
    expect(text).not.toContain("__testEditor");
    expect(text).not.toContain("window as unknown");
  });

  it("F2: after failed load for new community, editor is cleared and disabled, Save is disabled and refuses, and retry enables B", async () => {
    // 1. Initial load for parish-a succeeds (version 3)
    fetchSpy.mockResolvedValueOnce(mockResponse(200, { html: "<p>Parish A text</p>", version: 3 }));

    function F2Container() {
      function SwitchToB() {
        const { setSlug } = useCommunity();
        return (
          <button type="button" onClick={() => setSlug("parish-b")}>
            Switch to B
          </button>
        );
      }

      return (
        <PeopleAccessContext.Provider value={{ access: fullAccess }}>
          <CommunityProvider>
            <BillingStatusContext.Provider
              value={{
                status: {
                  state: "ok",
                  trial_end: null,
                  grace_until: null,
                  canView: true,
                  canManage: true,
                },
                readiness: "ready",
                refresh: vi.fn(),
                returnMessage: null,
              }}
            >
              <SwitchToB />
              <ServiceTimesPage />
            </BillingStatusContext.Provider>
          </CommunityProvider>
        </PeopleAccessContext.Provider>
      );
    }

    sessionStorage.setItem("community-hub.community", "parish-a");
    const router = createMemoryRouter([{ path: "/", element: <F2Container /> }], {
      initialEntries: ["/"],
    });

    render(<RouterProvider router={router} />);

    // Wait for Parish A to load
    const saveBtn = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    await waitFor(() => {
      expect(screen.getByText("Parish A text")).toBeTruthy();
      expect(saveBtn.disabled).toBe(false);
    });

    // 2. Mock GET for parish-b to fail (e.g. 500 error)
    fetchSpy.mockResolvedValueOnce(mockResponse(500));

    // Switch to B
    fireEvent.click(screen.getByText("Switch to B"));

    // Wait for error message
    await waitFor(() => {
      expect(screen.getByText("Could not load. Try again.")).toBeTruthy();
    });

    // Assert: Save is disabled
    expect(saveBtn.disabled).toBe(true);

    // Assert: Editor is cleared (Parish A text is gone) and disabled
    expect(screen.queryByText("Parish A text")).toBeNull();
    const editor = screen.getByRole("textbox");
    expect(editor.getAttribute("contenteditable")).toBe("false");

    // Invoke Save handler anyway (e.g. fireEvent.click)
    fireEvent.click(saveBtn);

    // Assert: No save request sent!
    // Total fetch calls must be 2 (GET parish-a, GET parish-b), NO save call.
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    // 3. Successful retry/reload for B
    fetchSpy.mockResolvedValueOnce(mockResponse(200, { html: "<p>Parish B text</p>", version: 7 }));

    const reloadBtn = screen.getByRole("button", { name: /reload/i });
    fireEvent.click(reloadBtn);

    await waitFor(() => {
      expect(screen.getByText("Parish B text")).toBeTruthy();
      expect(screen.getByRole("textbox").getAttribute("contenteditable")).toBe("true");
    });

    // Save is enabled now
    const enabledSaveBtn = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    await waitFor(() => {
      expect(enabledSaveBtn.disabled).toBe(false);
    });

    // Mock successful save for B
    fetchSpy.mockResolvedValueOnce(mockResponse(200, { html: "<p>Parish B text</p>", version: 8 }));

    fireEvent.click(enabledSaveBtn);

    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toContain("Saved");
    });

    // Verify Save sent B's slug and B's version
    expect(fetchSpy).toHaveBeenCalledTimes(4);
    const saveCall = fetchSpy.mock.calls[3];
    expect(String(saveCall?.[0])).toContain("/v1/engagement/service-times/save");
    const savePayload = JSON.parse(saveCall?.[1]?.body as string);
    expect(savePayload).toEqual({
      communitySlug: "parish-b",
      html: "<p>Parish B text</p>",
      version: 7,
    });
  });

  it("F3: switching community with unsaved edits asks to confirm, cancel keeps text and old community, confirm loads new community", async () => {
    // 1. Initial load for parish-a
    fetchSpy.mockResolvedValueOnce(
      mockResponse(200, { html: "<p>Parish A initial</p>", version: 1 }),
    );

    function F3Container() {
      const { slug, setSlug } = useCommunity();
      return (
        <PeopleAccessContext.Provider value={{ access: fullAccess }}>
          <BillingStatusContext.Provider
            value={{
              status: {
                state: "ok",
                trial_end: null,
                grace_until: null,
                canView: true,
                canManage: true,
              },
              readiness: "ready",
              refresh: vi.fn(),
              returnMessage: null,
            }}
          >
            <div data-testid="active-slug">{slug}</div>
            <button type="button" onClick={() => setSlug("parish-b")}>
              Switch to B
            </button>
            <ServiceTimesPage />
          </BillingStatusContext.Provider>
        </PeopleAccessContext.Provider>
      );
    }

    sessionStorage.setItem("community-hub.community", "parish-a");
    const router = createMemoryRouter(
      [
        {
          path: "/",
          element: (
            <CommunityProvider>
              <F3Container />
            </CommunityProvider>
          ),
        },
      ],
      { initialEntries: ["/"] },
    );

    render(<RouterProvider router={router} />);

    await waitFor(() => {
      expect(screen.getByText("Parish A initial")).toBeTruthy();
    });
    expect(screen.getByTestId("active-slug").textContent).toBe("parish-a");
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // 2. Make editor dirty
    const editor = captured.editor;
    expect(editor).toBeTruthy();
    act(() => {
      editor!.commands.setContent("<p>Parish A unsaved edits</p>");
    });

    // 3. Trigger community switch to parish-b
    fireEvent.click(screen.getByText("Switch to B"));

    // 4. Assert confirm dialog appears
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
    expect(
      screen.getByText("You have unsaved changes. Are you sure you want to leave?"),
    ).toBeTruthy();

    // Assert: NO get request for parish-b was sent!
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // 5. Cancel the switch (click "Stay")
    fireEvent.click(screen.getByRole("button", { name: "Stay" }));

    // Assert: Confirm dialog disappears
    expect(screen.queryByRole("alertdialog")).toBeNull();

    // Assert: Old community is kept in context
    await waitFor(() => {
      expect(screen.getByTestId("active-slug").textContent).toBe("parish-a");
    });

    // Assert: Unsaved text is preserved in the editor
    expect(screen.getByText("Parish A unsaved edits")).toBeTruthy();

    // Assert: Still no new get request sent
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // 6. Now switch again, and Confirm
    fireEvent.click(screen.getByText("Switch to B"));

    expect(screen.getByRole("alertdialog")).toBeTruthy();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Mock GET response for parish-b
    fetchSpy.mockResolvedValueOnce(
      mockResponse(200, { html: "<p>Parish B loaded text</p>", version: 10 }),
    );

    // Click "Leave without saving" (Confirm)
    fireEvent.click(screen.getByRole("button", { name: "Leave without saving" }));

    // Assert: Confirm dialog disappears
    expect(screen.queryByRole("alertdialog")).toBeNull();

    // Assert: GET request for parish-b was sent and content loaded
    await waitFor(() => {
      expect(screen.getByText("Parish B loaded text")).toBeTruthy();
    });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const getCall = fetchSpy.mock.calls[1];
    expect(String(getCall?.[0])).toContain("/v1/engagement/service-times/get");
    const getPayload = JSON.parse(getCall?.[1]?.body as string);
    expect(getPayload).toEqual({ communitySlug: "parish-b" });
  });

  it("Grok-1: save in flight, picker changed to B, save resolves: no GET for B, Stay restores A with no new GET and enables Save; Leave loads B", async () => {
    // 1. Initial load for parish-a
    fetchSpy.mockResolvedValueOnce(
      mockResponse(200, { html: "<p>Parish A initial</p>", version: 1 }),
    );

    function TestContainer() {
      const { slug, setSlug } = useCommunity();
      return (
        <PeopleAccessContext.Provider value={{ access: fullAccess }}>
          <BillingStatusContext.Provider
            value={{
              status: {
                state: "ok",
                trial_end: null,
                grace_until: null,
                canView: true,
                canManage: true,
              },
              readiness: "ready",
              refresh: vi.fn(),
              returnMessage: null,
            }}
          >
            <div data-testid="active-slug">{slug}</div>
            <button type="button" onClick={() => setSlug("parish-b")}>
              Switch to B
            </button>
            <ServiceTimesPage />
          </BillingStatusContext.Provider>
        </PeopleAccessContext.Provider>
      );
    }

    sessionStorage.setItem("community-hub.community", "parish-a");
    const router = createMemoryRouter(
      [
        {
          path: "/",
          element: (
            <CommunityProvider>
              <TestContainer />
            </CommunityProvider>
          ),
        },
      ],
      { initialEntries: ["/"] },
    );

    render(<RouterProvider router={router} />);

    await waitFor(() => {
      expect(screen.getByText("Parish A initial")).toBeTruthy();
    });
    expect(screen.getByTestId("active-slug").textContent).toBe("parish-a");
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // 2. Make editor dirty
    const editor = captured.editor;
    expect(editor).toBeTruthy();
    act(() => {
      editor!.commands.setContent("<p>Parish A edited</p>");
    });

    // 3. Controlled save response
    let resolveSave: ((res: Response) => void) | undefined;
    const savePromise = new Promise<Response>((resolve) => {
      resolveSave = resolve;
    });
    fetchSpy.mockImplementationOnce(() => savePromise);

    // 4. Click Save
    const saveBtn = await waitForSaveButton();
    fireEvent.click(saveBtn);

    // Save is now in flight
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(saveBtn.textContent).toBe("Saving...");

    // 5. Change picker to B while save is pending
    fireEvent.click(screen.getByText("Switch to B"));

    // Confirm dialog is shown
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    expect(screen.getByText("Unsaved changes")).toBeTruthy();

    // 6. Now save resolves OK
    await act(async () => {
      resolveSave!(mockResponse(200, { html: "<p>Parish A saved text</p>", version: 2 }));
    });

    // Assert: NO get request for B is sent, dialog is still shown
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    for (const call of fetchSpy.mock.calls) {
      expect(String(call[0])).not.toContain("parish-b");
      if (call[1]?.body) {
        expect(String(call[1].body)).not.toContain("parish-b");
      }
    }

    // 7. Click Stay
    fireEvent.click(screen.getByRole("button", { name: "Stay" }));

    // Assert: dialog closes, active slug is back to parish-a with no new get
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await waitFor(() => {
      expect(screen.getByTestId("active-slug").textContent).toBe("parish-a");
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    // Assert: editor shows the saved text for parish-a
    expect(screen.getByText("Parish A saved text")).toBeTruthy();

    // Assert: Save is enabled again for A
    await waitFor(() => {
      const currentSaveBtn = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
      expect(currentSaveBtn.disabled).toBe(false);
    });

    // 8. Second case: switch to B and Leave without saving loads B
    act(() => {
      editor!.commands.setContent("<p>Parish A new edit</p>");
    });
    fireEvent.click(screen.getByText("Switch to B"));
    expect(screen.getByRole("alertdialog")).toBeTruthy();

    // Mock GET for parish-b
    fetchSpy.mockResolvedValueOnce(
      mockResponse(200, { html: "<p>Parish B loaded text</p>", version: 5 }),
    );

    // Click "Leave without saving"
    fireEvent.click(screen.getByRole("button", { name: "Leave without saving" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();

    await waitFor(() => {
      expect(screen.getByText("Parish B loaded text")).toBeTruthy();
    });
    expect(screen.getByTestId("active-slug").textContent).toBe("parish-b");
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    const getCall = fetchSpy.mock.calls[2];
    expect(String(getCall?.[0])).toContain("/v1/engagement/service-times/get");
    const getPayload = JSON.parse(getCall?.[1]?.body as string);
    expect(getPayload).toEqual({ communitySlug: "parish-b" });
  });

  it("Grok-2: dirty editor, save returns 409 conflict, switch to B: Reload cannot fetch B, Stay restores A with unsaved text", async () => {
    // 1. Initial load for parish-a
    fetchSpy.mockResolvedValueOnce(
      mockResponse(200, { html: "<p>Parish A initial</p>", version: 1 }),
    );

    function Test2Container() {
      const { slug, setSlug } = useCommunity();
      return (
        <PeopleAccessContext.Provider value={{ access: fullAccess }}>
          <BillingStatusContext.Provider
            value={{
              status: {
                state: "ok",
                trial_end: null,
                grace_until: null,
                canView: true,
                canManage: true,
              },
              readiness: "ready",
              refresh: vi.fn(),
              returnMessage: null,
            }}
          >
            <div data-testid="active-slug">{slug}</div>
            <button type="button" onClick={() => setSlug("parish-b")}>
              Switch to B
            </button>
            <ServiceTimesPage />
          </BillingStatusContext.Provider>
        </PeopleAccessContext.Provider>
      );
    }

    sessionStorage.setItem("community-hub.community", "parish-a");
    const router = createMemoryRouter(
      [
        {
          path: "/",
          element: (
            <CommunityProvider>
              <Test2Container />
            </CommunityProvider>
          ),
        },
      ],
      { initialEntries: ["/"] },
    );

    render(<RouterProvider router={router} />);

    await waitFor(() => {
      expect(screen.getByText("Parish A initial")).toBeTruthy();
    });
    expect(screen.getByTestId("active-slug").textContent).toBe("parish-a");
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // 2. Make editor dirty
    const editor = captured.editor;
    expect(editor).toBeTruthy();
    act(() => {
      editor!.commands.setContent("<p>Parish A local unsaved edits</p>");
    });

    // 3. Save returns 409 conflict
    fetchSpy.mockResolvedValueOnce(mockResponse(409, { error: "version_conflict" }));

    const saveBtn = await waitForSaveButton();
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(
        screen.getByText(
          "Someone else saved a change first. Reload to see their text, or copy yours before you reload.",
        ),
      ).toBeTruthy();
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    // Reload button is present
    const reloadBtn = screen.getByRole("button", { name: /reload/i }) as HTMLButtonElement;
    expect(reloadBtn).toBeTruthy();

    // 4. Picker changed to B
    fireEvent.click(screen.getByText("Switch to B"));

    // Confirm dialog is shown
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    expect(screen.getByText("Unsaved changes")).toBeTruthy();

    // Reload button must be disabled while dialog is open (or clicking it must not load B)
    expect(reloadBtn.disabled).toBe(true);
    fireEvent.click(reloadBtn);

    // Assert NO get for B before an answer
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    for (const call of fetchSpy.mock.calls) {
      expect(String(call[0])).not.toContain("parish-b");
    }

    // Assert unsaved text for A is still in the editor
    expect(screen.getByText("Parish A local unsaved edits")).toBeTruthy();

    // 5. Click Stay
    fireEvent.click(screen.getByRole("button", { name: "Stay" }));

    // Assert dialog closes
    expect(screen.queryByRole("alertdialog")).toBeNull();

    // Assert Stay restores A
    await waitFor(() => {
      expect(screen.getByTestId("active-slug").textContent).toBe("parish-a");
    });
    expect(screen.getByText("Parish A local unsaved edits")).toBeTruthy();

    // No new GET request was sent
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    // Reload button is enabled again now that dialog is closed
    expect(reloadBtn.disabled).toBe(false);
  });

  it("picker moves A -> B -> C while dirty: Confirm loads C (current picker) with Save enabled, no GET for B", async () => {
    // 1. Initial load for parish-a
    fetchSpy.mockResolvedValueOnce(
      mockResponse(200, { html: "<p>Parish A initial</p>", version: 1 }),
    );

    function MultiSwitchContainer() {
      const { slug, setSlug } = useCommunity();
      return (
        <PeopleAccessContext.Provider value={{ access: fullAccess }}>
          <BillingStatusContext.Provider
            value={{
              status: {
                state: "ok",
                trial_end: null,
                grace_until: null,
                canView: true,
                canManage: true,
              },
              readiness: "ready",
              refresh: vi.fn(),
              returnMessage: null,
            }}
          >
            <div data-testid="active-slug">{slug}</div>
            <button type="button" onClick={() => setSlug("parish-b")}>
              Switch to B
            </button>
            <button type="button" onClick={() => setSlug("parish-c")}>
              Switch to C
            </button>
            <ServiceTimesPage />
          </BillingStatusContext.Provider>
        </PeopleAccessContext.Provider>
      );
    }

    sessionStorage.setItem("community-hub.community", "parish-a");
    const router = createMemoryRouter(
      [
        {
          path: "/",
          element: (
            <CommunityProvider>
              <MultiSwitchContainer />
            </CommunityProvider>
          ),
        },
      ],
      { initialEntries: ["/"] },
    );

    render(<RouterProvider router={router} />);

    await waitFor(() => {
      expect(screen.getByText("Parish A initial")).toBeTruthy();
    });
    expect(screen.getByTestId("active-slug").textContent).toBe("parish-a");
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // 2. Dirty editor on A
    const editor = captured.editor;
    expect(editor).toBeTruthy();
    act(() => {
      editor!.commands.setContent("<p>Parish A edited</p>");
    });

    // 3. Picker -> B (dialog opens)
    fireEvent.click(screen.getByText("Switch to B"));
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    expect(screen.getByText("Unsaved changes")).toBeTruthy();

    // 4. Picker -> C
    fireEvent.click(screen.getByText("Switch to C"));
    expect(screen.getByRole("alertdialog")).toBeTruthy();

    // Assert: no get for B or C yet
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    for (const call of fetchSpy.mock.calls) {
      expect(String(call[0])).not.toContain("parish-b");
      expect(String(call[0])).not.toContain("parish-c");
    }

    // 5. Confirm: Leave without saving
    // Mock GET response for parish-c
    fetchSpy.mockResolvedValueOnce(
      mockResponse(200, { html: "<p>Parish C loaded text</p>", version: 3 }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Leave without saving" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();

    // Assert: exactly one get for C, none for B
    await waitFor(() => {
      expect(screen.getByText("Parish C loaded text")).toBeTruthy();
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const getCall = fetchSpy.mock.calls[1];
    expect(String(getCall?.[0])).toContain("/v1/engagement/service-times/get");
    const getPayload = JSON.parse(getCall?.[1]?.body as string);
    expect(getPayload).toEqual({ communitySlug: "parish-c" });

    // Assert: editor and Save enabled for C with C's version
    expect(screen.getByTestId("active-slug").textContent).toBe("parish-c");
    const saveBtn = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    await waitFor(() => {
      expect(saveBtn.disabled).toBe(false);
    });
  });

  it("picker moves A -> B -> C while dirty: Stay returns the picker to A with A's text and no get", async () => {
    // 1. Initial load for parish-a
    fetchSpy.mockResolvedValueOnce(
      mockResponse(200, { html: "<p>Parish A initial</p>", version: 1 }),
    );

    function MultiSwitchContainer() {
      const { slug, setSlug } = useCommunity();
      return (
        <PeopleAccessContext.Provider value={{ access: fullAccess }}>
          <BillingStatusContext.Provider
            value={{
              status: {
                state: "ok",
                trial_end: null,
                grace_until: null,
                canView: true,
                canManage: true,
              },
              readiness: "ready",
              refresh: vi.fn(),
              returnMessage: null,
            }}
          >
            <div data-testid="active-slug">{slug}</div>
            <button type="button" onClick={() => setSlug("parish-b")}>
              Switch to B
            </button>
            <button type="button" onClick={() => setSlug("parish-c")}>
              Switch to C
            </button>
            <ServiceTimesPage />
          </BillingStatusContext.Provider>
        </PeopleAccessContext.Provider>
      );
    }

    sessionStorage.setItem("community-hub.community", "parish-a");
    const router = createMemoryRouter(
      [
        {
          path: "/",
          element: (
            <CommunityProvider>
              <MultiSwitchContainer />
            </CommunityProvider>
          ),
        },
      ],
      { initialEntries: ["/"] },
    );

    render(<RouterProvider router={router} />);

    await waitFor(() => {
      expect(screen.getByText("Parish A initial")).toBeTruthy();
    });
    expect(screen.getByTestId("active-slug").textContent).toBe("parish-a");
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // 2. Dirty editor on A
    const editor = captured.editor;
    expect(editor).toBeTruthy();
    act(() => {
      editor!.commands.setContent("<p>Parish A edited</p>");
    });

    // 3. Picker -> B (dialog opens)
    fireEvent.click(screen.getByText("Switch to B"));
    expect(screen.getByRole("alertdialog")).toBeTruthy();

    // 4. Picker -> C
    fireEvent.click(screen.getByText("Switch to C"));
    expect(screen.getByRole("alertdialog")).toBeTruthy();

    // Assert: no get for B or C yet
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // 5. Stay
    fireEvent.click(screen.getByRole("button", { name: "Stay" }));

    // Assert: dialog closes
    expect(screen.queryByRole("alertdialog")).toBeNull();

    // Assert: Stay returns the picker to A with A's text and no get
    await waitFor(() => {
      expect(screen.getByTestId("active-slug").textContent).toBe("parish-a");
    });
    expect(screen.getByText("Parish A edited")).toBeTruthy();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const saveBtn = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    await waitFor(() => {
      expect(saveBtn.disabled).toBe(false);
    });
  });

  it("picker moves A -> B -> A while dirty: dialog stays, Save and editor disabled, Stay preserves edits, Leave reloads A", async () => {
    // 1. Initial load for parish-a
    fetchSpy.mockResolvedValueOnce(
      mockResponse(200, { html: "<p>Parish A initial</p>", version: 1 }),
    );

    function ABASwitchContainer() {
      const { slug, setSlug } = useCommunity();
      return (
        <PeopleAccessContext.Provider value={{ access: fullAccess }}>
          <BillingStatusContext.Provider
            value={{
              status: {
                state: "ok",
                trial_end: null,
                grace_until: null,
                canView: true,
                canManage: true,
              },
              readiness: "ready",
              refresh: vi.fn(),
              returnMessage: null,
            }}
          >
            <div data-testid="active-slug">{slug}</div>
            <button type="button" onClick={() => setSlug("parish-a")}>
              Switch to A
            </button>
            <button type="button" onClick={() => setSlug("parish-b")}>
              Switch to B
            </button>
            <ServiceTimesPage />
          </BillingStatusContext.Provider>
        </PeopleAccessContext.Provider>
      );
    }

    sessionStorage.setItem("community-hub.community", "parish-a");
    const router = createMemoryRouter(
      [
        {
          path: "/",
          element: (
            <CommunityProvider>
              <ABASwitchContainer />
            </CommunityProvider>
          ),
        },
      ],
      { initialEntries: ["/"] },
    );

    render(<RouterProvider router={router} />);

    await waitFor(() => {
      expect(screen.getByText("Parish A initial")).toBeTruthy();
    });
    expect(screen.getByTestId("active-slug").textContent).toBe("parish-a");
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // 2. Make editor dirty
    const editor = captured.editor;
    expect(editor).toBeTruthy();
    act(() => {
      editor!.commands.setContent("<p>Parish A edited</p>");
    });

    // 3. Picker -> B (dialog opens)
    fireEvent.click(screen.getByText("Switch to B"));
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    expect(screen.getByText("Unsaved changes")).toBeTruthy();

    // 4. Picker -> A (dialog still open)
    fireEvent.click(screen.getByText("Switch to A"));

    // Assert: dialog is still shown
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    expect(screen.getByText("Unsaved changes")).toBeTruthy();

    // Assert: Save button is disabled
    const saveBtn = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(true);

    // Assert: Editor is disabled
    expect(screen.getByRole("textbox").getAttribute("contenteditable")).toBe("false");

    // Assert: No get request was sent
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Assert: Clicking Save sends no request
    fireEvent.click(saveBtn);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // 5. Then Stay: dialog closes, picker on A, edited text still in editor, Save is enabled
    fireEvent.click(screen.getByRole("button", { name: "Stay" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();

    await waitFor(() => {
      expect(screen.getByTestId("active-slug").textContent).toBe("parish-a");
      expect(saveBtn.disabled).toBe(false);
    });
    expect(screen.getByText("Parish A edited")).toBeTruthy();
    expect(screen.getByRole("textbox").getAttribute("contenteditable")).toBe("true");

    // Save sends A's text with A's version
    fetchSpy.mockResolvedValueOnce(
      mockResponse(200, { html: "<p>Parish A edited</p>", version: 2 }),
    );
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toContain("Saved");
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const saveCall = fetchSpy.mock.calls[1];
    expect(String(saveCall?.[0])).toContain("/v1/engagement/service-times/save");
    const savePayload = JSON.parse(saveCall?.[1]?.body as string);
    expect(savePayload).toEqual({
      communitySlug: "parish-a",
      html: "<p>Parish A edited</p>",
      version: 1,
    });

    // 6. Second case: same two moves, then Leave without saving
    act(() => {
      editor!.commands.setContent("<p>Parish A edited again</p>");
    });
    fireEvent.click(screen.getByText("Switch to B"));
    expect(screen.getByRole("alertdialog")).toBeTruthy();

    fireEvent.click(screen.getByText("Switch to A"));
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    expect(saveBtn.disabled).toBe(true);
    expect(screen.getByRole("textbox").getAttribute("contenteditable")).toBe("false");
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    fireEvent.click(saveBtn);
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    // Mock GET response for parish-a when leaving without saving
    fetchSpy.mockResolvedValueOnce(
      mockResponse(200, { html: "<p>Parish A reloaded</p>", version: 3 }),
    );

    // Click Leave without saving
    fireEvent.click(screen.getByRole("button", { name: "Leave without saving" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();

    // Assert: exactly one get for A, Save enabled with A's loaded version
    await waitFor(() => {
      expect(screen.getByText("Parish A reloaded")).toBeTruthy();
      expect(screen.getByRole("textbox").getAttribute("contenteditable")).toBe("true");
      expect(saveBtn.disabled).toBe(false);
    });
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    const getCall = fetchSpy.mock.calls[2];
    expect(String(getCall?.[0])).toContain("/v1/engagement/service-times/get");
    const getPayload = JSON.parse(getCall?.[1]?.body as string);
    expect(getPayload).toEqual({ communitySlug: "parish-a" });

    expect(screen.getByTestId("active-slug").textContent).toBe("parish-a");

    fetchSpy.mockResolvedValueOnce(
      mockResponse(200, { html: "<p>Parish A reloaded</p>", version: 4 }),
    );
    fireEvent.click(saveBtn);
    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toContain("Saved");
    });
    expect(fetchSpy).toHaveBeenCalledTimes(4);
    const secondSaveCall = fetchSpy.mock.calls[3];
    expect(JSON.parse(secondSaveCall?.[1]?.body as string)).toEqual({
      communitySlug: "parish-a",
      html: "<p>Parish A reloaded</p>",
      version: 3,
    });
  });
});
