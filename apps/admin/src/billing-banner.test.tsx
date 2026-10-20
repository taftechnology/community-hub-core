import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import axe from "axe-core";
import { StrictMode } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BillingStatus } from "./api";
import { BillingBanner } from "./billing-banner";
import { BillingStatusContext } from "./billing-status";
import { CommunityPicker, CommunityProvider } from "./community";
import { router, Shell } from "./shell";

const TOKEN = "token-1";

function resultIds(
  results: axe.AxeResults,
  bucket: "passes" | "violations" | "incomplete" | "inapplicable",
): string[] {
  return results[bucket].map((entry) => entry.id);
}

function mockStatusResponse(status: BillingStatus): Response {
  return new Response(JSON.stringify(status), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function flush(): Promise<void> {
  await act(async () => {});
  await act(async () => {});
}

const none: BillingStatus = {
  state: "none",
  trial_end: null,
  grace_until: null,
  canView: true,
  canManage: true,
};

const readOnlyEnded: BillingStatus = {
  state: "read_only",
  trial_end: null,
  grace_until: null,
  canView: true,
  canManage: true,
};

function renderBannerWithStatus(
  status: BillingStatus | null,
  options?: { slug?: string; returnMessage?: string | null },
) {
  const returnMessage = options?.returnMessage ?? null;
  return render(
    <MemoryRouter>
      <BillingStatusContext.Provider
        value={{
          status,
          readiness: status ? "ready" : "unavailable",
          refresh: vi.fn(),
          returnMessage,
        }}
      >
        <BillingBanner />
      </BillingStatusContext.Provider>
    </MemoryRouter>,
  );
}

describe("BillingBanner and Shell Billing Return", () => {
  beforeEach(async () => {
    sessionStorage.clear();
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    await router.navigate("/");
  });

  afterEach(() => {
    cleanup();
    sessionStorage.clear();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("renders no banner when no community is chosen", async () => {
    sessionStorage.removeItem("community-hub.community");
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    render(<Shell />);
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("renders no banner when status answers 403 with a status-like JSON body", async () => {
    sessionStorage.setItem("community-hub.community", "parish");
    let resolveStatus!: (res: Response) => void;
    const statusPromise = new Promise<Response>((resolve) => {
      resolveStatus = resolve;
    });

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input).includes("/v1/billing/status")) {
        return statusPromise;
      }
      return new Response(null, { status: 404 });
    });

    render(<Shell />);

    resolveStatus(
      new Response(
        JSON.stringify({
          state: "none",
          trial_end: null,
          grace_until: null,
          canView: true,
          canManage: true,
        }),
        {
          status: 403,
          headers: { "content-type": "application/json" },
        },
      ),
    );

    await act(async () => {
      await statusPromise;
    });

    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("renders no banner when status answers 500", async () => {
    sessionStorage.setItem("community-hub.community", "parish");
    let resolveStatus500!: (res: Response) => void;
    const status500Promise = new Promise<Response>((resolve) => {
      resolveStatus500 = resolve;
    });

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input).includes("/v1/billing/status")) {
        return status500Promise;
      }
      return new Response(null, { status: 404 });
    });

    render(<Shell />);

    resolveStatus500(new Response("Internal Server Error", { status: 500 }));

    await act(async () => {
      await status500Promise;
    });

    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("renders no banner when status answers 500 with a status-like JSON body", async () => {
    sessionStorage.setItem("community-hub.community", "parish");
    let resolveStatus500!: (res: Response) => void;
    const status500Promise = new Promise<Response>((resolve) => {
      resolveStatus500 = resolve;
    });

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input).includes("/v1/billing/status")) {
        return status500Promise;
      }
      return new Response(null, { status: 404 });
    });

    render(<Shell />);

    resolveStatus500(
      new Response(
        JSON.stringify({
          state: "read_only",
          trial_end: null,
          grace_until: null,
          canView: true,
          canManage: true,
        }),
        {
          status: 500,
          headers: { "content-type": "application/json" },
        },
      ),
    );

    await act(async () => {
      await status500Promise;
    });

    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  describe("banner rows with canManage true and false (pin 17)", () => {
    it("invoiced: never renders a banner (canManage true or false)", () => {
      const { container: c1 } = renderBannerWithStatus({
        state: "invoiced",
        trial_end: null,
        grace_until: null,
        canView: true,
        canManage: true,
      });
      expect(c1.innerHTML).toBe("");

      cleanup();

      const { container: c2 } = renderBannerWithStatus({
        state: "invoiced",
        trial_end: null,
        grace_until: null,
        canView: true,
        canManage: false,
      });
      expect(c2.innerHTML).toBe("");
    });

    it("none: shows choose plan message; action link requires canManage (pin 17)", () => {
      // canManage: true
      const { unmount } = renderBannerWithStatus({
        state: "none",
        trial_end: null,
        grace_until: null,
        canView: true,
        canManage: true,
      });
      const banner = screen.getByRole("status");
      expect(banner.textContent).toContain("Choose a plan to start using Community Hub");
      expect(banner.textContent).not.toContain("Ask an organisation owner or billing contact");
      const link = within(banner).getByRole("link", { name: "Choose a plan" });
      expect(link.getAttribute("href")).toBe("/settings/general");
      unmount();

      // canManage: false (pin 17)
      renderBannerWithStatus({
        state: "none",
        trial_end: null,
        grace_until: null,
        canView: false,
        canManage: false,
      });
      const bannerNoManage = screen.getByRole("status");
      expect(bannerNoManage.textContent).toContain(
        "Choose a plan to start using Community Hub. Ask an organisation owner or billing contact",
      );
      expect(within(bannerNoManage).queryByRole("link")).toBeNull();
      expect(within(bannerNoManage).queryByRole("button")).toBeNull();
    });

    it("ok with trial ending within 7 days: shows trial ends; action button requires canManage (pin 17)", () => {
      const now = new Date("2026-10-20T12:00:00Z");
      vi.setSystemTime(now);
      const trialEnd = new Date("2026-10-25T12:00:00Z").toISOString();
      const expectedDate = new Date(trialEnd).toLocaleDateString();

      // canManage: true
      const { unmount } = renderBannerWithStatus({
        state: "ok",
        trial_end: trialEnd,
        grace_until: null,
        canView: true,
        canManage: true,
      });
      const banner = screen.getByRole("status");
      expect(banner.textContent).toContain(`Your trial ends on ${expectedDate}`);
      expect(banner.textContent).not.toContain("Ask an organisation owner or billing contact");
      const button = within(banner).getByRole("button", { name: "Manage billing" });
      expect(button).toBeTruthy();
      unmount();

      // canManage: false (pin 17)
      renderBannerWithStatus({
        state: "ok",
        trial_end: trialEnd,
        grace_until: null,
        canView: true,
        canManage: false,
      });
      const bannerNoManage = screen.getByRole("status");
      expect(bannerNoManage.textContent).toContain(
        `Your trial ends on ${expectedDate}. Ask an organisation owner or billing contact`,
      );
      expect(within(bannerNoManage).queryByRole("button")).toBeNull();
      expect(within(bannerNoManage).queryByRole("link")).toBeNull();
    });

    it("retrying: warning variant with update card button; requires canManage (pin 17)", () => {
      // canManage: true
      const { unmount } = renderBannerWithStatus({
        state: "retrying",
        trial_end: null,
        grace_until: null,
        canView: true,
        canManage: true,
      });
      const banner = screen.getByRole("status");
      expect(banner.textContent).toContain("Payment failed, update your card");
      expect(banner.textContent).toContain("Warning:");
      expect(banner.textContent).not.toContain("Ask an organisation owner or billing contact");
      expect(within(banner).getByRole("button", { name: "Update card" })).toBeTruthy();
      unmount();

      // canManage: false (pin 17)
      renderBannerWithStatus({
        state: "retrying",
        trial_end: null,
        grace_until: null,
        canView: true,
        canManage: false,
      });
      const bannerNoManage = screen.getByRole("status");
      expect(bannerNoManage.textContent).toContain(
        "Payment failed, update your card. Ask an organisation owner or billing contact",
      );
      expect(within(bannerNoManage).queryByRole("button")).toBeNull();
      expect(within(bannerNoManage).queryByRole("link")).toBeNull();
    });

    it("grace: warning variant with pay invoice button; requires canManage (pin 17)", () => {
      const graceUntil = "2026-10-30T12:00:00Z";
      const expectedDate = new Date(graceUntil).toLocaleDateString();

      // canManage: true
      const { unmount } = renderBannerWithStatus({
        state: "grace",
        trial_end: null,
        grace_until: graceUntil,
        canView: true,
        canManage: true,
      });
      const banner = screen.getByRole("status");
      expect(banner.textContent).toContain(`Read-only on ${expectedDate}, pay the open invoice`);
      expect(banner.textContent).toContain("Warning:");
      expect(banner.textContent).not.toContain("Ask an organisation owner or billing contact");
      expect(within(banner).getByRole("button", { name: "Pay invoice" })).toBeTruthy();
      unmount();

      // canManage: false (pin 17)
      renderBannerWithStatus({
        state: "grace",
        trial_end: null,
        grace_until: graceUntil,
        canView: true,
        canManage: false,
      });
      const bannerNoManage = screen.getByRole("status");
      expect(bannerNoManage.textContent).toContain(
        `Read-only on ${expectedDate}, pay the open invoice. Ask an organisation owner or billing contact`,
      );
      expect(within(bannerNoManage).queryByRole("button")).toBeNull();
      expect(within(bannerNoManage).queryByRole("link")).toBeNull();
    });

    it("read_only unpaid (grace_until present): pay invoice button; requires canManage (pin 17)", () => {
      // canManage: true
      const { unmount } = renderBannerWithStatus({
        state: "read_only",
        trial_end: null,
        grace_until: "2026-10-30T12:00:00Z",
        canView: true,
        canManage: true,
      });
      const banner = screen.getByRole("alert");
      expect(banner.textContent).toContain("Read-only, pay the open invoice");
      expect(banner.textContent).not.toContain("Warning:");
      expect(banner.textContent).not.toContain("Ask an organisation owner or billing contact");
      expect(within(banner).getByRole("button", { name: "Pay invoice" })).toBeTruthy();
      unmount();

      // canManage: false (pin 17)
      renderBannerWithStatus({
        state: "read_only",
        trial_end: null,
        grace_until: "2026-10-30T12:00:00Z",
        canView: true,
        canManage: false,
      });
      const bannerNoManage = screen.getByRole("alert");
      expect(bannerNoManage.textContent).toContain(
        "Read-only, pay the open invoice. Ask an organisation owner or billing contact",
      );
      expect(within(bannerNoManage).queryByRole("button")).toBeNull();
      expect(within(bannerNoManage).queryByRole("link")).toBeNull();
    });

    it("read_only ended (grace_until null): choose plan link; requires canManage (pin 17)", () => {
      // canManage: true
      const { unmount } = renderBannerWithStatus({
        state: "read_only",
        trial_end: null,
        grace_until: null,
        canView: true,
        canManage: true,
      });
      const banner = screen.getByRole("alert");
      expect(banner.textContent).toContain("Subscription ended");
      expect(banner.textContent).not.toContain("Warning:");
      expect(banner.textContent).not.toContain("Ask an organisation owner or billing contact");
      const link = within(banner).getByRole("link", { name: "Choose a plan" });
      expect(link.getAttribute("href")).toBe("/settings/general");
      unmount();

      // canManage: false (pin 17)
      renderBannerWithStatus({
        state: "read_only",
        trial_end: null,
        grace_until: null,
        canView: true,
        canManage: false,
      });
      const bannerNoManage = screen.getByRole("alert");
      expect(bannerNoManage.textContent).toContain(
        "Subscription ended. Ask an organisation owner or billing contact",
      );
      expect(within(bannerNoManage).queryByRole("link")).toBeNull();
      expect(within(bannerNoManage).queryByRole("button")).toBeNull();
    });
  });

  describe("trial window boundary (vi.setSystemTime)", () => {
    it("trial at 8 days absent, at 7 present, past absent, null absent", () => {
      const now = new Date("2026-10-20T12:00:00.000Z");
      vi.setSystemTime(now);

      // 8 days in future -> absent
      const eightDays = new Date("2026-10-28T12:00:00.000Z").toISOString();
      const { container: c8 } = renderBannerWithStatus({
        state: "ok",
        trial_end: eightDays,
        grace_until: null,
        canView: true,
        canManage: true,
      });
      expect(c8.innerHTML).toBe("");
      cleanup();

      // 7 days in future -> present
      const sevenDays = new Date("2026-10-27T12:00:00.000Z").toISOString();
      renderBannerWithStatus({
        state: "ok",
        trial_end: sevenDays,
        grace_until: null,
        canView: true,
        canManage: true,
      });
      expect(screen.getByRole("status").textContent).toContain(
        `Your trial ends on ${new Date(sevenDays).toLocaleDateString()}`,
      );
      cleanup();

      // past -> absent
      const past = new Date("2026-10-19T12:00:00.000Z").toISOString();
      const { container: cPast } = renderBannerWithStatus({
        state: "ok",
        trial_end: past,
        grace_until: null,
        canView: true,
        canManage: true,
      });
      expect(cPast.innerHTML).toBe("");
      cleanup();

      // null -> absent
      const { container: cNull } = renderBannerWithStatus({
        state: "ok",
        trial_end: null,
        grace_until: null,
        canView: true,
        canManage: true,
      });
      expect(cNull.innerHTML).toBe("");
    });
  });

  describe("accessibility live regions (role alert vs status)", () => {
    it("role='alert' only on first appearance in read_only, role='status' otherwise", () => {
      const status: BillingStatus = {
        state: "read_only",
        trial_end: null,
        grace_until: null,
        canView: true,
        canManage: true,
      };

      // First appearance: role="alert"
      const { rerender } = render(
        <MemoryRouter>
          <BillingStatusContext.Provider
            value={{
              status,
              readiness: "ready",
              refresh: vi.fn(),
              returnMessage: null,
            }}
          >
            <BillingBanner />
          </BillingStatusContext.Provider>
        </MemoryRouter>,
      );

      expect(screen.getByRole("alert")).toBeTruthy();
      expect(screen.queryByRole("status")).toBeNull();

      // Re-render: role="status"
      rerender(
        <MemoryRouter>
          <BillingStatusContext.Provider
            value={{
              status,
              readiness: "ready",
              refresh: vi.fn(),
              returnMessage: null,
            }}
          >
            <BillingBanner />
          </BillingStatusContext.Provider>
        </MemoryRouter>,
      );

      expect(screen.getByRole("status")).toBeTruthy();
      expect(screen.queryByRole("alert")).toBeNull();
    });

    it("role='status' for other states", () => {
      const states: BillingStatus["state"][] = ["none", "retrying", "grace"];
      for (const state of states) {
        const { unmount } = renderBannerWithStatus({
          state,
          trial_end: null,
          grace_until: state === "grace" ? "2026-10-30T00:00:00Z" : null,
          canView: true,
          canManage: true,
        });
        expect(screen.getByRole("status")).toBeTruthy();
        expect(screen.queryByRole("alert")).toBeNull();
        unmount();
      }
    });

    it("role='alert' again when switching from one read_only community to another", () => {
      const status: BillingStatus = {
        state: "read_only",
        trial_end: null,
        grace_until: null,
        canView: true,
        canManage: true,
      };

      sessionStorage.setItem("community-hub.community", "parish");

      function tree() {
        return (
          <MemoryRouter>
            <CommunityProvider>
              <CommunityPicker />
              <BillingStatusContext.Provider
                value={{
                  status,
                  readiness: "ready",
                  refresh: vi.fn(),
                  returnMessage: null,
                }}
              >
                <BillingBanner />
              </BillingStatusContext.Provider>
            </CommunityProvider>
          </MemoryRouter>
        );
      }

      const { rerender } = render(tree());

      expect(screen.getByRole("alert")).toBeTruthy();
      expect(screen.queryByRole("status")).toBeNull();

      rerender(tree());

      expect(screen.getByRole("status")).toBeTruthy();
      expect(screen.queryByRole("alert")).toBeNull();

      fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
        target: { value: "cathedral" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Set" }));

      expect(screen.getByRole("alert")).toBeTruthy();
      expect(screen.queryByRole("status")).toBeNull();
    });
  });

  describe("portal action button triggers POST /v1/billing/portal", () => {
    it("posts to portal and assigns window.location to returned url", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify({ url: "https://billing.stripe.example.test/session-1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

      const assignMock = vi.fn();
      const loc = window.location;
      vi.stubGlobal("location", {
        ancestorOrigins: loc.ancestorOrigins,
        href: loc.href,
        origin: loc.origin,
        protocol: loc.protocol,
        host: loc.host,
        hostname: loc.hostname,
        port: loc.port,
        pathname: loc.pathname,
        search: loc.search,
        hash: loc.hash,
        assign: assignMock,
        replace: loc.replace.bind(loc),
        reload: loc.reload.bind(loc),
      });

      render(
        <MemoryRouter>
          <CommunityProvider>
            <CommunityPicker />
            <BillingStatusContext.Provider
              value={{
                status: {
                  state: "retrying",
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
              <BillingBanner />
            </BillingStatusContext.Provider>
          </CommunityProvider>
        </MemoryRouter>,
      );

      fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
        target: { value: "parish" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Set" }));

      const button = screen.getByRole("button", { name: "Update card" });
      fireEvent.click(button);

      await vi.waitFor(() => {
        expect(fetchSpy).toHaveBeenCalledWith(
          "https://au.api.example.test/v1/billing/portal",
          expect.objectContaining({
            method: "POST",
            body: JSON.stringify({ communitySlug: "parish" }),
          }),
        );
        expect(assignMock).toHaveBeenCalledWith("https://billing.stripe.example.test/session-1");
      });
    });

    it("does not navigate when the community changes before the Portal response resolves", async () => {
      let resolvePortal!: (res: Response) => void;
      const portalPromise = new Promise<Response>((resolve) => {
        resolvePortal = resolve;
      });

      vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
        if (String(input).includes("/v1/billing/portal")) {
          return portalPromise;
        }
        return Promise.resolve(new Response(null, { status: 404 }));
      });

      const assignMock = vi.fn();
      const loc = window.location;
      vi.stubGlobal("location", {
        ancestorOrigins: loc.ancestorOrigins,
        href: loc.href,
        origin: loc.origin,
        protocol: loc.protocol,
        host: loc.host,
        hostname: loc.hostname,
        port: loc.port,
        pathname: loc.pathname,
        search: loc.search,
        hash: loc.hash,
        assign: assignMock,
        replace: loc.replace.bind(loc),
        reload: loc.reload.bind(loc),
      });

      render(
        <MemoryRouter>
          <CommunityProvider>
            <CommunityPicker />
            <BillingStatusContext.Provider
              value={{
                status: {
                  state: "retrying",
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
              <BillingBanner />
            </BillingStatusContext.Provider>
          </CommunityProvider>
        </MemoryRouter>,
      );

      fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
        target: { value: "parish" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Set" }));

      fireEvent.click(screen.getByRole("button", { name: "Update card" }));

      fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
        target: { value: "cathedral" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Set" }));

      resolvePortal(
        new Response(JSON.stringify({ url: "https://billing.stripe.example.test/session-stale" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

      await act(async () => {
        await portalPromise;
      });
      await flush();

      expect(assignMock).not.toHaveBeenCalled();
    });
  });

  describe("navigation and community slug change status fetching", () => {
    it("navigating between routes makes no further status call and a community change makes exactly one", async () => {
      sessionStorage.setItem("community-hub.community", "parish");
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        const url = String(input);
        if (url.includes("/v1/billing/status")) {
          return mockStatusResponse({
            state: "none",
            trial_end: null,
            grace_until: null,
            canView: true,
            canManage: true,
          });
        }
        if (url.includes("/v1/access/grants/list")) {
          return new Response(
            JSON.stringify({
              grants: [],
              customRoles: [],
              builtIn: [],
              userLinks: [],
              catalogue: [],
              permissions: [],
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          );
        }
        return new Response(null, { status: 404 });
      });

      render(<Shell />);

      // Exactly 1 status call initially for "parish"
      await vi.waitFor(() => {
        const statusCalls = fetchSpy.mock.calls.filter((c) =>
          String(c[0]).includes("/v1/billing/status"),
        );
        expect(statusCalls).toHaveLength(1);
        expect(statusCalls[0]?.[1]?.body).toBe(JSON.stringify({ communitySlug: "parish" }));
      });

      // Navigate from "/" to "/settings/users"
      await router.navigate("/settings/users");
      await act(async () => {});
      // Still exactly 1 status call
      const statusCallsAfterNav = fetchSpy.mock.calls.filter((c) =>
        String(c[0]).includes("/v1/billing/status"),
      );
      expect(statusCallsAfterNav).toHaveLength(1);

      // Change community slug to "cathedral" -> exactly one more call
      fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
        target: { value: "cathedral" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Set" }));

      await vi.waitFor(() => {
        const statusCallsAfterChange = fetchSpy.mock.calls.filter((c) =>
          String(c[0]).includes("/v1/billing/status"),
        );
        expect(statusCallsAfterChange).toHaveLength(2);
        expect(statusCallsAfterChange[1]?.[1]?.body).toBe(
          JSON.stringify({ communitySlug: "cathedral" }),
        );
      });
    });

    it("clears the banner on a community change while new status is pending, and stays clear on 403", async () => {
      sessionStorage.setItem("community-hub.community", "parish");

      let resolveCathedral!: (res: Response) => void;
      const cathedralPromise = new Promise<Response>((resolve) => {
        resolveCathedral = resolve;
      });

      vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const url = String(input);
        if (url.includes("/v1/billing/status")) {
          const body = JSON.parse(String((init as RequestInit).body));
          if (body.communitySlug === "parish") {
            return mockStatusResponse({
              state: "read_only",
              trial_end: null,
              grace_until: null,
              canView: true,
              canManage: true,
            });
          }
          if (body.communitySlug === "cathedral") {
            return cathedralPromise;
          }
        }
        return new Response(null, { status: 404 });
      });

      render(<Shell />);

      // A answers read_only -> banner is shown
      expect(await screen.findByText("Subscription ended")).toBeTruthy();
      expect(screen.queryByRole("alert")).toBeTruthy();

      // Switch to B, with B's status held unresolved
      fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
        target: { value: "cathedral" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Set" }));

      // Assert there is no alert or status region immediately
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.queryByRole("status")).toBeNull();
      expect(screen.queryByText("Subscription ended")).toBeNull();

      // Resolve B with 403
      resolveCathedral(new Response(null, { status: 403 }));

      await act(async () => {
        await cathedralPromise;
      });

      // Assert there is still none
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.queryByRole("status")).toBeNull();
      expect(screen.queryByText("Subscription ended")).toBeNull();
    });
  });

  describe("Return from Stripe (?billing=)", () => {
    it("?billing=done on /: shows payment received, strips parameter, refreshes after 5s", async () => {
      vi.useFakeTimers();
      sessionStorage.setItem("community-hub.community", "parish");
      window.history.replaceState(null, "", "/?billing=done");

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
        mockStatusResponse({
          state: "none",
          trial_end: null,
          grace_until: null,
          canView: true,
          canManage: true,
        }),
      );

      render(<Shell />);

      // Shows message in banner region
      expect(screen.getByRole("status").textContent).toContain(
        "Payment received, your plan will appear shortly",
      );
      // Parameter removed
      expect(window.location.search).not.toContain("billing");

      // Initial status call count: 1
      const initialCalls = fetchSpy.mock.calls.filter((c) =>
        String(c[0]).includes("/v1/billing/status"),
      ).length;

      // Advance 5 seconds
      vi.advanceTimersByTime(5000);
      await act(async () => {});

      // Refreshed once after 5s and return message is cleared
      const afterCalls = fetchSpy.mock.calls.filter((c) =>
        String(c[0]).includes("/v1/billing/status"),
      ).length;
      expect(afterCalls).toBe(initialCalls + 1);
      expect(screen.queryByText("Payment received, your plan will appear shortly")).toBeNull();

      // Advance further -> no additional calls
      vi.advanceTimersByTime(10000);
      const laterCalls = fetchSpy.mock.calls.filter((c) =>
        String(c[0]).includes("/v1/billing/status"),
      ).length;
      expect(laterCalls).toBe(afterCalls);
    });

    it("?billing=done on /settings/users: shows payment received, strips parameter, refreshes after 5s", async () => {
      vi.useFakeTimers();
      sessionStorage.setItem("community-hub.community", "parish");
      await router.navigate("/settings/users");
      window.history.replaceState(null, "", "/settings/users?billing=done");

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
        mockStatusResponse({
          state: "none",
          trial_end: null,
          grace_until: null,
          canView: true,
          canManage: true,
        }),
      );

      render(<Shell />);

      expect(screen.getByRole("status").textContent).toContain(
        "Payment received, your plan will appear shortly",
      );
      expect(window.location.search).not.toContain("billing");

      const initialCalls = fetchSpy.mock.calls.filter((c) =>
        String(c[0]).includes("/v1/billing/status"),
      ).length;

      vi.advanceTimersByTime(5000);
      await act(async () => {});

      const afterCalls = fetchSpy.mock.calls.filter((c) =>
        String(c[0]).includes("/v1/billing/status"),
      ).length;
      expect(afterCalls).toBe(initialCalls + 1);
      expect(screen.queryByText("Payment received, your plan will appear shortly")).toBeNull();
    });

    it("under StrictMode ?billing=done refreshes once after 5s", async () => {
      vi.useFakeTimers();
      sessionStorage.setItem("community-hub.community", "parish");
      window.history.replaceState(null, "", "/?billing=done");

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
        mockStatusResponse({
          state: "none",
          trial_end: null,
          grace_until: null,
          canView: true,
          canManage: true,
        }),
      );

      render(
        <StrictMode>
          <Shell />
        </StrictMode>,
      );

      const initialCalls = fetchSpy.mock.calls.filter((c) =>
        String(c[0]).includes("/v1/billing/status"),
      ).length;

      vi.advanceTimersByTime(6000);

      const afterCalls = fetchSpy.mock.calls.filter((c) =>
        String(c[0]).includes("/v1/billing/status"),
      ).length;
      expect(afterCalls).toBe(initialCalls + 1);
    });

    it("done timer refresh does not leak stale status into a newly switched community", async () => {
      vi.useFakeTimers();
      sessionStorage.setItem("community-hub.community", "parish");
      window.history.replaceState(null, "", "/?billing=done");
      let parishCalls = 0;
      let release!: (r: Response) => void;
      const held = new Promise<Response>((r) => {
        release = r;
      });
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        if (String(input).includes("/v1/billing/status")) {
          const body = JSON.parse(String((init as RequestInit).body));
          if (body.communitySlug === "parish") {
            parishCalls++;
            return parishCalls === 1 ? mockStatusResponse(none) : held;
          }
          return new Response(null, { status: 403 });
        }
        return new Response(null, { status: 404 });
      });
      render(<Shell />);
      await flush();
      vi.advanceTimersByTime(5000);
      await flush();
      expect(parishCalls).toBe(2);
      fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
        target: { value: "cathedral" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Set" }));
      await flush();
      release(mockStatusResponse(readOnlyEnded));
      await act(async () => {
        await held;
      });
      await flush();
      expect(screen.queryByRole("status")).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.queryByText("Subscription ended")).toBeNull();
    });

    it("after ?billing=done, message is present at 5s while refresh is held and clears once resolved", async () => {
      vi.useFakeTimers();
      sessionStorage.setItem("community-hub.community", "parish");
      window.history.replaceState(null, "", "/?billing=done");
      let parishCalls = 0;
      let release!: (r: Response) => void;
      const held = new Promise<Response>((r) => {
        release = r;
      });
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        if (String(input).includes("/v1/billing/status")) {
          const body = JSON.parse(String((init as RequestInit).body));
          if (body.communitySlug === "parish") {
            parishCalls++;
            return parishCalls === 1 ? mockStatusResponse(none) : held;
          }
        }
        return new Response(null, { status: 404 });
      });

      render(<Shell />);
      await flush();
      expect(screen.getByText("Payment received, your plan will appear shortly")).toBeTruthy();
      expect(parishCalls).toBe(1);

      vi.advanceTimersByTime(5000);
      await flush();
      expect(parishCalls).toBe(2);
      expect(screen.getByText("Payment received, your plan will appear shortly")).toBeTruthy();

      release(mockStatusResponse(none));
      await act(async () => {
        await held;
      });
      await flush();

      expect(screen.queryByText("Payment received, your plan will appear shortly")).toBeNull();
    });

    it("under StrictMode ?billing=done return message stays visible before 5s timer", async () => {
      vi.useFakeTimers();
      sessionStorage.setItem("community-hub.community", "parish");
      window.history.replaceState(null, "", "/?billing=done");

      vi.spyOn(globalThis, "fetch").mockImplementation(async () => mockStatusResponse(none));

      render(
        <StrictMode>
          <Shell />
        </StrictMode>,
      );
      await flush();

      expect(screen.getByText("Payment received, your plan will appear shortly")).toBeTruthy();
    });

    it("?billing=cancelled on / and on /settings/users: shows Checkout was cancelled, strips parameter", async () => {
      sessionStorage.setItem("community-hub.community", "parish");
      window.history.replaceState(null, "", "/?billing=cancelled");

      const { unmount } = render(<Shell />);
      expect(screen.getByRole("status").textContent).toContain("Checkout was cancelled");
      expect(window.location.search).not.toContain("billing");
      unmount();

      cleanup();
      await router.navigate("/settings/users");
      window.history.replaceState(null, "", "/settings/users?billing=cancelled");

      render(<Shell />);
      expect(screen.getByRole("status").textContent).toContain("Checkout was cancelled");
      expect(window.location.search).not.toContain("billing");
    });

    it("?billing=cancelled on a none organisation: shows both Checkout was cancelled and Choose a plan with action", async () => {
      sessionStorage.setItem("community-hub.community", "parish");
      window.history.replaceState(null, "", "/?billing=cancelled");

      vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
        mockStatusResponse({
          state: "none",
          trial_end: null,
          grace_until: null,
          canView: true,
          canManage: true,
        }),
      );

      render(<Shell />);

      // Both messages are shown
      expect(await screen.findByText("Checkout was cancelled")).toBeTruthy();
      expect(await screen.findByText("Choose a plan to start using Community Hub")).toBeTruthy();

      // Action link is shown since canManage is true
      const link = screen.getByRole("link", { name: "Choose a plan" });
      expect(link.getAttribute("href")).toBe("/settings/general");
    });

    it("under StrictMode ?billing=cancelled return message stays visible after mount", async () => {
      sessionStorage.setItem("community-hub.community", "parish");
      window.history.replaceState(null, "", "/?billing=cancelled");

      vi.spyOn(globalThis, "fetch").mockImplementation(async () => mockStatusResponse(none));

      render(
        <StrictMode>
          <Shell />
        </StrictMode>,
      );
      await flush();

      expect(screen.getByText("Checkout was cancelled")).toBeTruthy();
    });

    it("?billing=portal on / and on /settings/users: strips parameter and triggers status refresh", async () => {
      sessionStorage.setItem("community-hub.community", "parish");
      window.history.replaceState(null, "", "/?billing=portal");

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
        mockStatusResponse({
          state: "none",
          trial_end: null,
          grace_until: null,
          canView: true,
          canManage: true,
        }),
      );

      const { unmount } = render(<Shell />);
      expect(window.location.search).not.toContain("billing");

      // Initial mount loads slug + portal triggers immediate refresh (exactly 2 status calls)
      await vi.waitFor(() => {
        const calls = fetchSpy.mock.calls.filter((c) =>
          String(c[0]).includes("/v1/billing/status"),
        );
        expect(calls).toHaveLength(2);
      });
      unmount();

      cleanup();
      fetchSpy.mockClear();
      await router.navigate("/settings/users");
      window.history.replaceState(null, "", "/settings/users?billing=portal");

      render(<Shell />);
      expect(window.location.search).not.toContain("billing");
      await vi.waitFor(() => {
        const calls = fetchSpy.mock.calls.filter((c) =>
          String(c[0]).includes("/v1/billing/status"),
        );
        expect(calls).toHaveLength(2);
      });
    });

    it("stale portal refresh for previous community does not overwrite new community banner on switch", async () => {
      sessionStorage.setItem("community-hub.community", "parish");
      window.history.replaceState(null, "", "/?billing=portal");

      let parishCalls = 0;
      let resolveParishPortal!: (res: Response) => void;
      const parishPortalPromise = new Promise<Response>((resolve) => {
        resolveParishPortal = resolve;
      });

      vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const url = String(input);
        if (url.includes("/v1/billing/status")) {
          const body = JSON.parse(String((init as RequestInit).body));
          if (body.communitySlug === "parish") {
            parishCalls++;
            if (parishCalls === 1) {
              return mockStatusResponse({
                state: "read_only",
                trial_end: null,
                grace_until: null,
                canView: true,
                canManage: true,
              });
            }
            return parishPortalPromise;
          }
          if (body.communitySlug === "cathedral") {
            return new Response(null, { status: 403 });
          }
        }
        return new Response(null, { status: 404 });
      });

      render(<Shell />);

      expect(await screen.findByText("Subscription ended")).toBeTruthy();

      fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
        target: { value: "cathedral" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Set" }));

      await vi.waitFor(() => {
        expect(screen.queryByRole("alert")).toBeNull();
        expect(screen.queryByRole("status")).toBeNull();
      });

      resolveParishPortal(
        mockStatusResponse({
          state: "read_only",
          trial_end: null,
          grace_until: null,
          canView: true,
          canManage: true,
        }),
      );

      await act(async () => {
        await parishPortalPromise;
      });

      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.queryByRole("status")).toBeNull();
      expect(screen.queryByText("Subscription ended")).toBeNull();
    });

    it("?billing=<script> renders nothing from the value (pin 18) and removes parameter", async () => {
      sessionStorage.setItem("community-hub.community", "parish");
      window.history.replaceState(null, "", '/?billing=<script>alert("xss")</script>');

      const { container } = render(<Shell />);
      expect(window.location.search).not.toContain("billing");
      expect(container.innerHTML).not.toContain("<script>");
      expect(container.innerHTML).not.toContain("alert");
      expect(screen.queryByText(/<script>/)).toBeNull();
    });
  });

  describe("axe accessibility per state", () => {
    it("reports no axe violations across all states", async () => {
      const now = new Date("2026-10-20T12:00:00Z");
      vi.setSystemTime(now);

      const testStates: BillingStatus[] = [
        {
          state: "none",
          trial_end: null,
          grace_until: null,
          canView: true,
          canManage: true,
        },
        {
          state: "ok",
          trial_end: "2026-10-25T12:00:00Z",
          grace_until: null,
          canView: true,
          canManage: true,
        },
        {
          state: "retrying",
          trial_end: null,
          grace_until: null,
          canView: true,
          canManage: true,
        },
        {
          state: "grace",
          trial_end: null,
          grace_until: "2026-10-30T12:00:00Z",
          canView: true,
          canManage: true,
        },
        {
          state: "read_only",
          trial_end: null,
          grace_until: "2026-10-30T12:00:00Z",
          canView: true,
          canManage: true,
        },
        {
          state: "read_only",
          trial_end: null,
          grace_until: null,
          canView: true,
          canManage: true,
        },
      ];

      for (const st of testStates) {
        const { container, unmount } = renderBannerWithStatus(st);
        const results = await axe.run(container, {
          rules: { "color-contrast": { enabled: false } },
        });
        expect(resultIds(results, "violations")).toEqual([]);
        unmount();
        cleanup();
      }

      // Return message state
      const { container: returnContainer } = renderBannerWithStatus(null, {
        returnMessage: "Payment received, your plan will appear shortly",
      });
      const returnResults = await axe.run(returnContainer, {
        rules: { "color-contrast": { enabled: false } },
      });
      expect(resultIds(returnResults, "violations")).toEqual([]);
    });
  });
});
