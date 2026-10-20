import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import axe from "axe-core";
import { StrictMode, useState } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BillingStatus } from "./api";
import { BillingStatusContext, BillingStatusProvider } from "./billing-status";
import { CommunityProvider, useCommunity } from "./community";
import { GeneralSettingsPage } from "./general-settings";

const TOKEN = "token-test-1";

function resultIds(
  results: axe.AxeResults,
  bucket: "passes" | "violations" | "incomplete" | "inapplicable",
): string[] {
  return results[bucket].map((entry) => entry.id);
}

async function flush(): Promise<void> {
  await act(async () => {});
  await act(async () => {});
}

function mockResponse(status: number, body: unknown): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function renderGeneralSettings(options: {
  status: BillingStatus | null;
  slug?: string | null;
  refresh?: () => Promise<void>;
  returnMessage?: string | null;
}) {
  const { status, slug = "parish", refresh = vi.fn().mockResolvedValue(undefined), returnMessage = null } = options;
  if (slug) {
    sessionStorage.setItem("community-hub.community", slug);
  } else {
    sessionStorage.removeItem("community-hub.community");
  }
  return render(
    <MemoryRouter>
      <CommunityProvider>
        <BillingStatusContext.Provider
          value={{
            status,
            refresh,
            returnMessage,
          }}
        >
          <GeneralSettingsPage />
        </BillingStatusContext.Provider>
      </CommunityProvider>
    </MemoryRouter>,
  );
}

describe("GeneralSettingsPage - Settings -> General Settings -> Billing", () => {
  let assignMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    sessionStorage.clear();
    sessionStorage.setItem("community-hub.access-token", TOKEN);
    assignMock = vi.fn();
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
  });

  afterEach(() => {
    cleanup();
    sessionStorage.clear();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("Empty, error, and permissions", () => {
    it("renders no billing content when no community is chosen", () => {
      renderGeneralSettings({
        status: null,
        slug: null,
      });

      expect(screen.getByRole("heading", { level: 1, name: "General Settings" })).toBeTruthy();
      expect(screen.queryByText("Billing status unavailable")).toBeNull();
      expect(screen.queryByText("Billing is handled by invoice.")).toBeNull();
      expect(screen.queryByText("You do not have access to billing for this organisation.")).toBeNull();
    });

    it("renders 'Billing status unavailable' when status is null but community is chosen", () => {
      renderGeneralSettings({
        status: null,
        slug: "parish",
      });

      expect(screen.getByText("Billing status unavailable")).toBeTruthy();
    });

    it("renders 'You do not have access to billing for this organisation.' when neither canView nor canManage", () => {
      renderGeneralSettings({
        status: {
          state: "ok",
          trial_end: null,
          grace_until: null,
          canView: false,
          canManage: false,
        },
      });

      expect(screen.getByText("You do not have access to billing for this organisation.")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Manage billing" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Start subscription" })).toBeNull();
    });

    it("renders 'Billing is handled by invoice.' and no actions when state is invoiced", () => {
      renderGeneralSettings({
        status: {
          state: "invoiced",
          planKey: "starter",
          quantity: 2,
          current_period_end: "2026-11-20T00:00:00.000Z",
          trial_end: null,
          grace_until: null,
          canView: true,
          canManage: true,
        },
      });

      expect(screen.getByText("Billing is handled by invoice.")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Manage billing" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Start subscription" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Finish payment" })).toBeNull();
    });
  });

  describe("canView content", () => {
    it("renders state in words, plan label, quantity, current period end, trial end, and grace until", () => {
      renderGeneralSettings({
        status: {
          state: "ok",
          planKey: "starter",
          quantity: 4,
          current_period_end: "2026-12-31T00:00:00.000Z",
          trial_end: "2026-10-25T00:00:00.000Z",
          grace_until: null,
          canView: true,
          canManage: false,
        },
      });

      expect(screen.getByText("Active")).toBeTruthy();
      expect(screen.getByText("Starter")).toBeTruthy();
      expect(screen.getByText("4")).toBeTruthy();
      expect(screen.getByText(new Date("2026-12-31T00:00:00.000Z").toLocaleDateString())).toBeTruthy();
      expect(screen.getByText(new Date("2026-10-25T00:00:00.000Z").toLocaleDateString())).toBeTruthy();

      // View-only caller does NOT see manage actions
      expect(screen.queryByRole("button", { name: "Manage billing" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Start subscription" })).toBeNull();
    });

    it("renders read_only state in words and grace until date", () => {
      renderGeneralSettings({
        status: {
          state: "read_only",
          planKey: "starter",
          quantity: 1,
          current_period_end: null,
          trial_end: null,
          grace_until: "2026-11-05T00:00:00.000Z",
          canView: true,
          canManage: false,
        },
      });

      expect(screen.getByText("Read-only")).toBeTruthy();
      expect(screen.getByText(new Date("2026-11-05T00:00:00.000Z").toLocaleDateString())).toBeTruthy();
    });
  });

  describe("canManage actions and plan list", () => {
    it("renders 'Manage billing' (Portal) button in ok, retrying, grace, and read_only", () => {
      const states = ["ok", "retrying", "grace", "read_only"] as const;
      for (const st of states) {
        cleanup();
        renderGeneralSettings({
          status: {
            state: st,
            planKey: "starter",
            trial_end: null,
            grace_until: st === "grace" || st === "read_only" ? "2026-11-01T00:00:00.000Z" : null,
            canView: true,
            canManage: true,
          },
        });

        expect(screen.getByRole("button", { name: "Manage billing" })).toBeTruthy();
      }
    });

    it("does not render 'Manage billing' in state none", () => {
      renderGeneralSettings({
        status: {
          state: "none",
          trial_end: null,
          grace_until: null,
          canView: true,
          canManage: true,
        },
      });

      expect(screen.queryByRole("button", { name: "Manage billing" })).toBeNull();
    });

    it("fetches and renders plans list only in none and read_only without grace_until", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        mockResponse(200, {
          plans: [
            { key: "starter", trialAvailable: true },
            { key: "growth", trialAvailable: false },
            { key: "custom-unmapped", trialAvailable: false },
          ],
        }),
      );

      renderGeneralSettings({
        status: {
          state: "none",
          trial_end: null,
          grace_until: null,
          canView: true,
          canManage: true,
        },
      });

      await flush();

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0]!;
      expect(url).toBe("https://au.api.example.test/v1/billing/plans");
      expect(JSON.parse(init?.body as string)).toEqual({ communitySlug: "parish" });

      // Plan labels
      expect(screen.getByText("Starter")).toBeTruthy();
      expect(screen.getByText("Growth")).toBeTruthy();
      // Unknown plan key shows the key
      expect(screen.getByText("custom-unmapped")).toBeTruthy();

      // trialAvailable copy
      expect(screen.getByText("Includes a free trial")).toBeTruthy();

      // "Start subscription" buttons
      const buttons = screen.getAllByRole("button", { name: "Start subscription" });
      expect(buttons).toHaveLength(3);
    });

    it("fetches and renders plans in read_only ended (grace_until null)", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        mockResponse(200, {
          plans: [{ key: "starter", trialAvailable: true }],
        }),
      );

      renderGeneralSettings({
        status: {
          state: "read_only",
          trial_end: null,
          grace_until: null,
          canView: true,
          canManage: true,
        },
      });

      await flush();

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(screen.getByText("Starter")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Start subscription" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Manage billing" })).toBeTruthy();
    });

    it("does NOT fetch plans in read_only with grace_until", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");

      renderGeneralSettings({
        status: {
          state: "read_only",
          trial_end: null,
          grace_until: "2026-11-10T00:00:00.000Z",
          canView: true,
          canManage: true,
        },
      });

      await flush();

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(screen.queryByRole("button", { name: "Start subscription" })).toBeNull();
    });

    it("does NOT render 'Start subscription' or fetch plans in ok, retrying, and grace with canManage: true", async () => {
      const states = ["ok", "retrying", "grace"] as const;
      for (const st of states) {
        cleanup();
        const fetchSpy = vi.spyOn(globalThis, "fetch");

        renderGeneralSettings({
          status: {
            state: st,
            planKey: "starter",
            trial_end: null,
            grace_until: st === "grace" ? "2026-11-10T00:00:00.000Z" : null,
            canView: true,
            canManage: true,
          },
        });

        await flush();

        expect(screen.queryByRole("button", { name: "Start subscription" })).toBeNull();
        expect(fetchSpy).not.toHaveBeenCalled();
      }
    });
  });

  describe("Security pin 17: actions need canManage", () => {
    it("never renders Manage billing or Start subscription when canManage is false (pin 17)", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        mockResponse(200, {
          plans: [{ key: "starter", trialAvailable: true }],
        }),
      );

      // 1. In none with canManage: false
      const { unmount } = renderGeneralSettings({
        status: {
          state: "none",
          trial_end: null,
          grace_until: null,
          canView: true,
          canManage: false,
        },
      });

      await flush();

      expect(screen.queryByRole("button", { name: "Start subscription" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Manage billing" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Finish payment" })).toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();

      unmount();

      // 2. In ok with canManage: false
      renderGeneralSettings({
        status: {
          state: "ok",
          trial_end: null,
          grace_until: null,
          canView: true,
          canManage: false,
        },
      });

      await flush();
      expect(screen.queryByRole("button", { name: "Manage billing" })).toBeNull();
    });
  });

  describe("Checkout action and 409 conflict cases", () => {
    it("assigns window.location on successful Checkout", async () => {
      vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(
          mockResponse(200, { plans: [{ key: "starter", trialAvailable: true }] }),
        )
        .mockResolvedValueOnce(
          mockResponse(200, { url: "https://checkout.stripe.example.test/session-abc" }),
        );

      renderGeneralSettings({
        status: {
          state: "none",
          trial_end: null,
          grace_until: null,
          canView: true,
          canManage: true,
        },
      });

      await flush();

      const button = screen.getByRole("button", { name: "Start subscription" });
      fireEvent.click(button);

      await flush();

      expect(assignMock).toHaveBeenCalledTimes(1);
      expect(assignMock).toHaveBeenCalledWith("https://checkout.stripe.example.test/session-abc");
    });

    it("Checkout 409 in none offers Portal via 'Finish payment' button", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(
          mockResponse(200, { plans: [{ key: "starter", trialAvailable: true }] }),
        )
        .mockResolvedValueOnce(mockResponse(409, { error: "conflict" }))
        .mockResolvedValueOnce(
          mockResponse(200, { url: "https://billing.stripe.example.test/portal-finish" }),
        );

      renderGeneralSettings({
        status: {
          state: "none",
          trial_end: null,
          grace_until: null,
          canView: true,
          canManage: true,
        },
      });

      await flush();

      const startBtn = screen.getByRole("button", { name: "Start subscription" });
      fireEvent.click(startBtn);

      await flush();

      // Shows "Finish payment"
      const finishBtn = screen.getByRole("button", { name: "Finish payment" });
      expect(finishBtn).toBeTruthy();

      // Clicking Finish payment calls portal
      fireEvent.click(finishBtn);
      await flush();

      expect(fetchSpy).toHaveBeenCalledTimes(3);
      const [portalUrl, portalInit] = fetchSpy.mock.calls[2]!;
      expect(portalUrl).toBe("https://au.api.example.test/v1/billing/portal");
      expect(JSON.parse(portalInit?.body as string)).toEqual({ communitySlug: "parish" });
      expect(assignMock).toHaveBeenCalledWith("https://billing.stripe.example.test/portal-finish");
    });

    it("Checkout 409 in ended read_only shows 'Contact support' instead of plan list", async () => {
      vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(
          mockResponse(200, { plans: [{ key: "starter", trialAvailable: true }] }),
        )
        .mockResolvedValueOnce(mockResponse(409, { error: "conflict" }));

      renderGeneralSettings({
        status: {
          state: "read_only",
          trial_end: null,
          grace_until: null,
          canView: true,
          canManage: true,
        },
      });

      await flush();

      const startBtn = screen.getByRole("button", { name: "Start subscription" });
      fireEvent.click(startBtn);

      await flush();

      expect(screen.getByText("Contact support")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Start subscription" })).toBeNull();
    });

    it("Checkout other 409 triggers refresh", async () => {
      const refreshMock = vi.fn().mockResolvedValue(undefined);
      let resolveCheckout!: (res: Response) => void;
      const checkoutPromise = new Promise<Response>((res) => {
        resolveCheckout = res;
      });

      vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(
          mockResponse(200, { plans: [{ key: "starter", trialAvailable: true }] }),
        )
        .mockImplementationOnce(() => checkoutPromise);

      function DynamicStatusContainer() {
        const [currentStatus, setCurrentStatus] = useState<BillingStatus>({
          state: "none",
          trial_end: null,
          grace_until: null,
          canView: true,
          canManage: true,
        });

        return (
          <BillingStatusContext.Provider
            value={{
              status: currentStatus,
              refresh: refreshMock,
              returnMessage: null,
            }}
          >
            <button
              type="button"
              onClick={() =>
                setCurrentStatus({
                  state: "ok",
                  trial_end: null,
                  grace_until: null,
                  canView: true,
                  canManage: true,
                })
              }
            >
              Update Status
            </button>
            <GeneralSettingsPage />
          </BillingStatusContext.Provider>
        );
      }

      sessionStorage.setItem("community-hub.community", "parish");
      render(
        <MemoryRouter>
          <CommunityProvider>
            <DynamicStatusContainer />
          </CommunityProvider>
        </MemoryRouter>,
      );

      await flush();

      // Click "Start subscription"
      fireEvent.click(screen.getByRole("button", { name: "Start subscription" }));

      // While checkout is in flight, swap status to "ok" (not "none" and not ended "read_only")
      fireEvent.click(screen.getByRole("button", { name: "Update Status" }));
      await flush();

      // Resolve checkout with 409
      resolveCheckout(mockResponse(409, { error: "conflict" }));
      await flush();

      expect(refreshMock).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole("button", { name: "Finish payment" })).toBeNull();
      expect(screen.queryByText("Contact support")).toBeNull();
    });
  });

  describe("Portal action and 409 conflict case", () => {
    it("assigns window.location on successful Portal click", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        mockResponse(200, { url: "https://billing.stripe.example.test/session-portal" }),
      );

      renderGeneralSettings({
        status: {
          state: "ok",
          trial_end: null,
          grace_until: null,
          canView: true,
          canManage: true,
        },
      });

      const button = screen.getByRole("button", { name: "Manage billing" });
      fireEvent.click(button);

      await flush();

      expect(assignMock).toHaveBeenCalledTimes(1);
      expect(assignMock).toHaveBeenCalledWith("https://billing.stripe.example.test/session-portal");
    });

    it("Portal 409 hides the button and refreshes status", async () => {
      const refreshMock = vi.fn().mockResolvedValue(undefined);
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        mockResponse(409, { error: "portal_conflict" }),
      );

      renderGeneralSettings({
        status: {
          state: "ok",
          trial_end: null,
          grace_until: null,
          canView: true,
          canManage: true,
        },
        refresh: refreshMock,
      });

      const button = screen.getByRole("button", { name: "Manage billing" });
      fireEvent.click(button);

      await flush();

      expect(screen.queryByRole("button", { name: "Manage billing" })).toBeNull();
      expect(refreshMock).toHaveBeenCalledTimes(1);
    });

    it("Portal 409 reached from 'Finish payment' hides 'Finish payment' and refreshes status", async () => {
      const refreshMock = vi.fn().mockResolvedValue(undefined);
      vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(
          mockResponse(200, { plans: [{ key: "starter", trialAvailable: true }] }),
        )
        .mockResolvedValueOnce(mockResponse(409, { error: "checkout_conflict" }))
        .mockResolvedValueOnce(mockResponse(409, { error: "portal_conflict" }));

      renderGeneralSettings({
        status: {
          state: "none",
          trial_end: null,
          grace_until: null,
          canView: true,
          canManage: true,
        },
        refresh: refreshMock,
      });

      await flush();

      // Click Start subscription -> triggers Checkout 409 in "none"
      fireEvent.click(screen.getByRole("button", { name: "Start subscription" }));
      await flush();

      // "Finish payment" button appears
      const finishBtn = screen.getByRole("button", { name: "Finish payment" });
      expect(finishBtn).toBeTruthy();

      // Click "Finish payment" -> triggers Portal 409
      fireEvent.click(finishBtn);
      await flush();

      // "Finish payment" must be hidden and refresh called
      expect(screen.queryByRole("button", { name: "Finish payment" })).toBeNull();
      expect(refreshMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("Error copy: 422, 503, and no raw error text", () => {
    it("shows 'This plan is not available yet' on 422", async () => {
      vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(
          mockResponse(200, { plans: [{ key: "starter", trialAvailable: true }] }),
        )
        .mockResolvedValueOnce(mockResponse(422, { error: "unsupported_plan" }));

      renderGeneralSettings({
        status: {
          state: "none",
          trial_end: null,
          grace_until: null,
          canView: true,
          canManage: true,
        },
      });

      await flush();

      fireEvent.click(screen.getByRole("button", { name: "Start subscription" }));
      await flush();

      expect(screen.getByText("This plan is not available yet")).toBeTruthy();
      expect(screen.queryByText("unsupported_plan")).toBeNull();
    });

    it("shows 'Billing is unavailable, try again shortly' on 503", async () => {
      vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(
          mockResponse(200, { plans: [{ key: "starter", trialAvailable: true }] }),
        )
        .mockResolvedValueOnce(mockResponse(503, { error: "service_unavailable" }));

      renderGeneralSettings({
        status: {
          state: "none",
          trial_end: null,
          grace_until: null,
          canView: true,
          canManage: true,
        },
      });

      await flush();

      fireEvent.click(screen.getByRole("button", { name: "Start subscription" }));
      await flush();

      expect(screen.getByText("Billing is unavailable, try again shortly")).toBeTruthy();
      expect(screen.queryByText("service_unavailable")).toBeNull();
    });

    it("shows 'Billing is unavailable, try again shortly' on 500 without displaying raw error JSON", async () => {
      vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(
          mockResponse(200, { plans: [{ key: "starter", trialAvailable: true }] }),
        )
        .mockResolvedValueOnce(
          mockResponse(500, { message: "CRITICAL_DATABASE_CRASH_UNEXPECTED_TOKEN" }),
        );

      renderGeneralSettings({
        status: {
          state: "none",
          trial_end: null,
          grace_until: null,
          canView: true,
          canManage: true,
        },
      });

      await flush();

      fireEvent.click(screen.getByRole("button", { name: "Start subscription" }));
      await flush();

      expect(screen.getByText("Billing is unavailable, try again shortly")).toBeTruthy();
      expect(screen.queryByText("CRITICAL_DATABASE_CRASH_UNEXPECTED_TOKEN")).toBeNull();
    });

    it("never treats non-200 with valid-shaped JSON as success", async () => {
      vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(
          mockResponse(200, { plans: [{ key: "starter", trialAvailable: true }] }),
        )
        .mockResolvedValueOnce(
          mockResponse(403, { url: "https://stripe.example.test/should-not-redirect" }),
        );

      renderGeneralSettings({
        status: {
          state: "none",
          trial_end: null,
          grace_until: null,
          canView: true,
          canManage: true,
        },
      });

      await flush();

      fireEvent.click(screen.getByRole("button", { name: "Start subscription" }));
      await flush();

      expect(assignMock).not.toHaveBeenCalled();
      expect(screen.getByText("Billing is unavailable, try again shortly")).toBeTruthy();
    });

    it("never treats non-200 plans response (403) with valid plans JSON as success", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        mockResponse(403, { plans: [{ key: "starter", trialAvailable: true }] }),
      );

      renderGeneralSettings({
        status: {
          state: "none",
          trial_end: null,
          grace_until: null,
          canView: true,
          canManage: true,
        },
      });

      await flush();

      expect(screen.queryByRole("button", { name: "Start subscription" })).toBeNull();
      expect(screen.queryByText("Starter")).toBeNull();
      expect(screen.getByText("Billing is unavailable, try again shortly")).toBeTruthy();
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it("never treats non-200 plans response (500) with valid plans JSON as success", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        mockResponse(500, { plans: [{ key: "starter", trialAvailable: true }] }),
      );

      renderGeneralSettings({
        status: {
          state: "none",
          trial_end: null,
          grace_until: null,
          canView: true,
          canManage: true,
        },
      });

      await flush();

      expect(screen.queryByRole("button", { name: "Start subscription" })).toBeNull();
      expect(screen.queryByText("Starter")).toBeNull();
      expect(screen.getByText("Billing is unavailable, try again shortly")).toBeTruthy();
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it("Portal shows 'This plan is not available yet' on 422 without raw error text", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        mockResponse(422, { error: "unsupported_portal_action" }),
      );

      renderGeneralSettings({
        status: {
          state: "ok",
          trial_end: null,
          grace_until: null,
          canView: true,
          canManage: true,
        },
      });

      await flush();

      fireEvent.click(screen.getByRole("button", { name: "Manage billing" }));
      await flush();

      expect(screen.getByText("This plan is not available yet")).toBeTruthy();
      expect(screen.queryByText("unsupported_portal_action")).toBeNull();
    });

    it("Portal shows 'Billing is unavailable, try again shortly' on 503 without raw error text", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        mockResponse(503, { error: "stripe_gateway_timeout" }),
      );

      renderGeneralSettings({
        status: {
          state: "ok",
          trial_end: null,
          grace_until: null,
          canView: true,
          canManage: true,
        },
      });

      await flush();

      fireEvent.click(screen.getByRole("button", { name: "Manage billing" }));
      await flush();

      expect(screen.getByText("Billing is unavailable, try again shortly")).toBeTruthy();
      expect(screen.queryByText("stripe_gateway_timeout")).toBeNull();
    });

    it("plans shows 'This plan is not available yet' on 422 without raw error text", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        mockResponse(422, { error: "catalog_unavailable" }),
      );

      renderGeneralSettings({
        status: {
          state: "none",
          trial_end: null,
          grace_until: null,
          canView: true,
          canManage: true,
        },
      });

      await flush();

      expect(screen.getByText("This plan is not available yet")).toBeTruthy();
      expect(screen.queryByText("catalog_unavailable")).toBeNull();
      expect(screen.queryByRole("button", { name: "Start subscription" })).toBeNull();
    });

    it("plans shows 'Billing is unavailable, try again shortly' on 503 without raw error text", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        mockResponse(503, { error: "database_down" }),
      );

      renderGeneralSettings({
        status: {
          state: "none",
          trial_end: null,
          grace_until: null,
          canView: true,
          canManage: true,
        },
      });

      await flush();

      expect(screen.getByText("Billing is unavailable, try again shortly")).toBeTruthy();
      expect(screen.queryByText("database_down")).toBeNull();
      expect(screen.queryByRole("button", { name: "Start subscription" })).toBeNull();
    });
  });

  describe("Response generation guards (community switch while request pending)", () => {
    function SwitchableContainer({ status }: { status: BillingStatus }) {
      function SwitchButton() {
        const { setSlug } = useCommunity();
        return (
          <button type="button" onClick={() => setSlug("parish-b")}>
            Switch
          </button>
        );
      }

      return (
        <MemoryRouter>
          <CommunityProvider>
            <BillingStatusContext.Provider
              value={{
                status,
                refresh: vi.fn(),
                returnMessage: null,
              }}
            >
              <SwitchButton />
              <GeneralSettingsPage />
            </BillingStatusContext.Provider>
          </CommunityProvider>
        </MemoryRouter>
      );
    }

    it("discards plans response when community switches before it resolves (200 and non-200)", async () => {
      sessionStorage.setItem("community-hub.community", "parish-a");
      let resolvePlansA!: (res: Response) => void;
      const plansPromiseA = new Promise<Response>((res) => {
        resolvePlansA = res;
      });

      vi.spyOn(globalThis, "fetch").mockImplementation((url, init) => {
        if (typeof url === "string" && url.includes("/v1/billing/plans")) {
          const body = JSON.parse(init?.body as string);
          if (body.communitySlug === "parish-a") {
            return plansPromiseA;
          }
          return Promise.resolve(
            mockResponse(200, {
              plans: [{ key: "growth", trialAvailable: false }],
            }),
          );
        }
        return Promise.resolve(mockResponse(200, {}));
      });

      render(
        <SwitchableContainer
          status={{
            state: "none",
            trial_end: null,
            grace_until: null,
            canView: true,
            canManage: true,
          }}
        />,
      );

      // Plans request is pending for parish-a
      // Switch community to parish-b
      fireEvent.click(screen.getByRole("button", { name: "Switch" }));

      // Release plans response for parish-a with 200 (starter)
      resolvePlansA(
        mockResponse(200, {
          plans: [{ key: "starter", trialAvailable: true }],
        }),
      );

      await flush();

      // Because the response was for parish-a after generation changed, starter must be discarded
      expect(screen.queryByText("Starter")).toBeNull();
      // And parish-b's response shows Growth
      expect(screen.getByText("Growth")).toBeTruthy();

      // Now test non-200 release for plans:
      cleanup();
      sessionStorage.setItem("community-hub.community", "parish-a");
      let resolvePlansFail!: (res: Response) => void;
      const plansPromiseFail = new Promise<Response>((res) => {
        resolvePlansFail = res;
      });

      vi.spyOn(globalThis, "fetch").mockImplementation((url, init) => {
        if (typeof url === "string" && url.includes("/v1/billing/plans")) {
          const body = JSON.parse(init?.body as string);
          if (body.communitySlug === "parish-a") {
            return plansPromiseFail;
          }
          return Promise.resolve(
            mockResponse(200, {
              plans: [{ key: "growth", trialAvailable: false }],
            }),
          );
        }
        return Promise.resolve(mockResponse(200, {}));
      });

      render(
        <SwitchableContainer
          status={{
            state: "none",
            trial_end: null,
            grace_until: null,
            canView: true,
            canManage: true,
          }}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: "Switch" }));
      resolvePlansFail(mockResponse(503, { error: "unavailable" }));
      await flush();

      // No notice displayed because parish-a error was discarded
      expect(screen.queryByText("Billing is unavailable, try again shortly")).toBeNull();
    });

    it("discards Checkout response (200 and non-200) when community switches while pending", async () => {
      sessionStorage.setItem("community-hub.community", "parish-a");
      let resolveCheckout200!: (res: Response) => void;
      const checkoutPromise200 = new Promise<Response>((res) => {
        resolveCheckout200 = res;
      });

      vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(
          mockResponse(200, { plans: [{ key: "starter", trialAvailable: true }] }),
        )
        .mockImplementation((url) => {
          if (typeof url === "string" && url.includes("/v1/billing/checkout")) {
            return checkoutPromise200;
          }
          return Promise.resolve(mockResponse(200, {}));
        });

      render(
        <SwitchableContainer
          status={{
            state: "none",
            trial_end: null,
            grace_until: null,
            canView: true,
            canManage: true,
          }}
        />,
      );

      await flush();

      // Click start subscription for parish-a
      fireEvent.click(screen.getByRole("button", { name: "Start subscription" }));

      // Switch community
      fireEvent.click(screen.getByRole("button", { name: "Switch" }));

      // Release checkout response with 200 url
      resolveCheckout200(
        mockResponse(200, { url: "https://checkout.stripe.example.test/session-stale" }),
      );

      await flush();

      // assignMock must not have been called
      expect(assignMock).not.toHaveBeenCalled();

      // Now test non-200 release (409) for checkout:
      cleanup();
      sessionStorage.setItem("community-hub.community", "parish-a");
      let resolveCheckout409!: (res: Response) => void;
      const checkoutPromise409 = new Promise<Response>((res) => {
        resolveCheckout409 = res;
      });

      vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(
          mockResponse(200, { plans: [{ key: "starter", trialAvailable: true }] }),
        )
        .mockImplementation((url) => {
          if (typeof url === "string" && url.includes("/v1/billing/checkout")) {
            return checkoutPromise409;
          }
          return Promise.resolve(mockResponse(200, {}));
        });

      render(
        <SwitchableContainer
          status={{
            state: "none",
            trial_end: null,
            grace_until: null,
            canView: true,
            canManage: true,
          }}
        />,
      );

      await flush();

      fireEvent.click(screen.getByRole("button", { name: "Start subscription" }));
      fireEvent.click(screen.getByRole("button", { name: "Switch" }));
      resolveCheckout409(mockResponse(409, { error: "conflict" }));
      await flush();

      // "Finish payment" must not be offered because the 409 was for parish-a
      expect(screen.queryByRole("button", { name: "Finish payment" })).toBeNull();
    });

    it("discards Portal response (200 and non-200) when community switches while pending", async () => {
      sessionStorage.setItem("community-hub.community", "parish-a");
      let resolvePortal200!: (res: Response) => void;
      const portalPromise200 = new Promise<Response>((res) => {
        resolvePortal200 = res;
      });

      vi.spyOn(globalThis, "fetch").mockImplementation((url) => {
        if (typeof url === "string" && url.includes("/v1/billing/portal")) {
          return portalPromise200;
        }
        return Promise.resolve(mockResponse(200, {}));
      });

      render(
        <SwitchableContainer
          status={{
            state: "ok",
            trial_end: null,
            grace_until: null,
            canView: true,
            canManage: true,
          }}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: "Manage billing" }));

      // Switch community
      fireEvent.click(screen.getByRole("button", { name: "Switch" }));

      // Release portal response with 200
      resolvePortal200(
        mockResponse(200, { url: "https://billing.stripe.example.test/session-portal-stale" }),
      );

      await flush();

      // assignMock must not have been called
      expect(assignMock).not.toHaveBeenCalled();

      // Now test non-200 (409) release for portal:
      cleanup();
      sessionStorage.setItem("community-hub.community", "parish-a");
      let resolvePortal409!: (res: Response) => void;
      const portalPromise409 = new Promise<Response>((res) => {
        resolvePortal409 = res;
      });

      vi.spyOn(globalThis, "fetch").mockImplementation((url) => {
        if (typeof url === "string" && url.includes("/v1/billing/portal")) {
          return portalPromise409;
        }
        return Promise.resolve(mockResponse(200, {}));
      });

      render(
        <SwitchableContainer
          status={{
            state: "ok",
            trial_end: null,
            grace_until: null,
            canView: true,
            canManage: true,
          }}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: "Manage billing" }));
      fireEvent.click(screen.getByRole("button", { name: "Switch" }));
      resolvePortal409(mockResponse(409, { error: "conflict" }));
      await flush();

      // Button is still present for parish-b (not hidden by stale parish-a 409)
      expect(screen.queryByRole("button", { name: "Manage billing" })).toBeTruthy();
    });

    it("regression: switching community from none (manage) to ok (view-only) never requests plans for B or shows notice", async () => {
      sessionStorage.setItem("community-hub.community", "parish-a");

      const plansCallsForB: unknown[] = [];
      vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
        const urlStr = typeof url === "string" ? url : (url as Request).url;
        const body = init?.body ? JSON.parse(init.body as string) : {};

        if (urlStr.includes("/v1/billing/status")) {
          if (body.communitySlug === "parish-a") {
            return mockResponse(200, {
              state: "none",
              trial_end: null,
              grace_until: null,
              canView: true,
              canManage: true,
            });
          }
          if (body.communitySlug === "parish-b") {
            return mockResponse(200, {
              state: "ok",
              planKey: "starter",
              trial_end: null,
              grace_until: null,
              canView: true,
              canManage: false,
            });
          }
        }

        if (urlStr.includes("/v1/billing/plans")) {
          if (body.communitySlug === "parish-a") {
            return mockResponse(200, {
              plans: [{ key: "starter", trialAvailable: true }],
            });
          }
          if (body.communitySlug === "parish-b") {
            plansCallsForB.push(body);
            return mockResponse(403, { error: "forbidden" });
          }
        }

        return mockResponse(200, {});
      });

      function SwitchableWithRealProviders() {
        const { setSlug } = useCommunity();
        return (
          <>
            <button type="button" onClick={() => setSlug("parish-b")}>
              Switch
            </button>
            <GeneralSettingsPage />
          </>
        );
      }

      render(
        <MemoryRouter>
          <CommunityProvider>
            <BillingStatusProvider>
              <SwitchableWithRealProviders />
            </BillingStatusProvider>
          </CommunityProvider>
        </MemoryRouter>,
      );

      await flush();

      expect(screen.getByText("Starter")).toBeTruthy();

      fireEvent.click(screen.getByRole("button", { name: "Switch" }));
      await flush();

      expect(plansCallsForB).toHaveLength(0);
      expect(screen.queryByText("Billing is unavailable, try again shortly")).toBeNull();
    });

    it("discards plans response when community switches after fetch resolves but before json() resolves", async () => {
      sessionStorage.setItem("community-hub.community", "parish-a");

      let resolveJsonPlans!: (body: unknown) => void;
      const jsonPromise = new Promise((resolve) => {
        resolveJsonPlans = resolve;
      });

      const heldResponse = {
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: () => jsonPromise,
      } as unknown as Response;

      vi.spyOn(globalThis, "fetch").mockImplementation((url, init) => {
        if (typeof url === "string" && url.includes("/v1/billing/plans")) {
          const body = JSON.parse(init?.body as string);
          if (body.communitySlug === "parish-a") {
            return Promise.resolve(heldResponse);
          }
          return Promise.resolve(mockResponse(200, { plans: [] }));
        }
        return Promise.resolve(mockResponse(200, {}));
      });

      render(
        <SwitchableContainer
          status={{
            state: "none",
            trial_end: null,
            grace_until: null,
            canView: true,
            canManage: true,
          }}
        />,
      );

      await flush();

      fireEvent.click(screen.getByRole("button", { name: "Switch" }));
      await flush();

      resolveJsonPlans({
        plans: [{ key: "starter", trialAvailable: true }],
      });
      await flush();

      expect(screen.queryByText("Starter")).toBeNull();
      expect(screen.queryByRole("button", { name: "Start subscription" })).toBeNull();
    });

    it("discards Checkout response when community switches after fetch resolves but before json() resolves", async () => {
      sessionStorage.setItem("community-hub.community", "parish-a");

      let resolveJsonCheckout!: (body: unknown) => void;
      const jsonPromise = new Promise((resolve) => {
        resolveJsonCheckout = resolve;
      });

      const heldResponse = {
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: () => jsonPromise,
      } as unknown as Response;

      vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(
          mockResponse(200, { plans: [{ key: "starter", trialAvailable: true }] }),
        )
        .mockImplementation((url) => {
          if (typeof url === "string" && url.includes("/v1/billing/checkout")) {
            return Promise.resolve(heldResponse);
          }
          return Promise.resolve(mockResponse(200, {}));
        });

      render(
        <SwitchableContainer
          status={{
            state: "none",
            trial_end: null,
            grace_until: null,
            canView: true,
            canManage: true,
          }}
        />,
      );

      await flush();

      fireEvent.click(screen.getByRole("button", { name: "Start subscription" }));
      await flush();

      fireEvent.click(screen.getByRole("button", { name: "Switch" }));
      await flush();

      resolveJsonCheckout({
        url: "https://checkout.stripe.example.test/session-post-json-stale",
      });
      await flush();

      expect(assignMock).not.toHaveBeenCalled();
    });

    it("discards Portal response when community switches after fetch resolves but before json() resolves", async () => {
      sessionStorage.setItem("community-hub.community", "parish-a");

      let resolveJsonPortal!: (body: unknown) => void;
      const jsonPromise = new Promise((resolve) => {
        resolveJsonPortal = resolve;
      });

      const heldResponse = {
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: () => jsonPromise,
      } as unknown as Response;

      vi.spyOn(globalThis, "fetch").mockImplementation((url) => {
        if (typeof url === "string" && url.includes("/v1/billing/portal")) {
          return Promise.resolve(heldResponse);
        }
        return Promise.resolve(mockResponse(200, {}));
      });

      render(
        <SwitchableContainer
          status={{
            state: "ok",
            trial_end: null,
            grace_until: null,
            canView: true,
            canManage: true,
          }}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: "Manage billing" }));
      await flush();

      fireEvent.click(screen.getByRole("button", { name: "Switch" }));
      await flush();

      resolveJsonPortal({
        url: "https://billing.stripe.example.test/session-portal-post-json-stale",
      });
      await flush();

      expect(assignMock).not.toHaveBeenCalled();
    });
  });

  describe("StrictMode and Accessibility (axe)", () => {
    it("renders cleanly in StrictMode", async () => {
      sessionStorage.setItem("community-hub.community", "parish");
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        mockResponse(200, {
          plans: [{ key: "starter", trialAvailable: true }],
        }),
      );

      render(
        <StrictMode>
          <MemoryRouter>
            <CommunityProvider>
              <BillingStatusContext.Provider
                value={{
                  status: {
                    state: "none",
                    trial_end: null,
                    grace_until: null,
                    canView: true,
                    canManage: true,
                  },
                  refresh: vi.fn(),
                  returnMessage: null,
                }}
              >
                <GeneralSettingsPage />
              </BillingStatusContext.Provider>
            </CommunityProvider>
          </MemoryRouter>
        </StrictMode>,
      );

      await flush();

      expect(screen.getByRole("heading", { level: 1, name: "General Settings" })).toBeTruthy();
      expect(screen.getByText("Starter")).toBeTruthy();
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it("reports no axe violations across states", async () => {
      const { container } = renderGeneralSettings({
        status: {
          state: "ok",
          planKey: "starter",
          quantity: 2,
          current_period_end: "2026-12-01T00:00:00.000Z",
          trial_end: null,
          grace_until: null,
          canView: true,
          canManage: true,
        },
      });

      const results = await axe.run(container, {
        rules: {
          "color-contrast": { enabled: false },
        },
      });

      expect(resultIds(results, "violations")).toEqual([]);
    });
  });
});
