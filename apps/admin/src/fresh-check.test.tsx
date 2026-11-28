import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FRESH_TEXT, FreshCheck, type FreshOutcome } from "./fresh-check";
import { router, Shell } from "./shell";

// Which screens render the shared "Confirm it's you" panel, and what the panel does. The wrapper
// below renders the real panel and notes each time a screen asks for it, so a screen that drew its
// own copy of the panel is not counted.
const shared = vi.hoisted(() => ({ renders: [] as { level: number | undefined }[] }));

vi.mock("./fresh-check", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./fresh-check")>();
  return {
    ...actual,
    FreshCheck: (props: Parameters<typeof actual.FreshCheck>[0]) => {
      shared.renders.push({ level: props.level });
      return <actual.FreshCheck {...props} />;
    },
  };
});

const SLUG = "test-community";
const TOKEN = "admin-token-" + "1";
const ACCESS_KEY = "community-hub.access-token";
const HANDLE_KEY = "community-hub.signout-handle";
// Synthetic. The code is a six-digit number no real authenticator holds.
const CODE = "135790";

function resultIds(results: axe.AxeResults): string[] {
  return results.violations.map((entry) => entry.id);
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(async () => {
  shared.renders.length = 0;
  sessionStorage.clear();
  await router.navigate("/");
});

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---- the panel on its own ---------------------------------------------------------------------

function Panel(
  props: Partial<Parameters<typeof FreshCheck>[0]> & {
    onCode?: (c: string) => Promise<FreshOutcome>;
  },
) {
  return (
    <FreshCheck
      hasApp
      passkeyUsable={false}
      onCode={async () => "passed"}
      onPasskey={async () => "passed"}
      onCancel={() => {}}
      {...props}
    />
  );
}

describe("FreshCheck, the panel", () => {
  it("shows Confirm it's you with the code field and Cancel, takes the focus, and passes axe", async () => {
    const { container } = render(<Panel />);
    const heading = screen.getByRole("heading", { name: "Confirm it's you", level: 2 });
    expect(document.activeElement).toBe(heading);
    expect(screen.getByLabelText("Authenticator code")).toBeTruthy();
    expect(screen.getByText("The 6 digits your authenticator app shows.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Confirm" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Use a passkey" })).toBeNull();
    const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(resultIds(results)).toEqual([]);
  });

  it("takes the heading level and the reason from its screen", () => {
    render(<Panel level={4} reason="Do this before you view a child's details." />);
    expect(screen.getByRole("heading", { name: "Confirm it's you", level: 4 })).toBeTruthy();
    expect(screen.getByText("Do this before you view a child's details.")).toBeTruthy();
  });

  it("keeps digits only, and enables Confirm for six of them", () => {
    render(<Panel />);
    const input = screen.getByLabelText("Authenticator code") as HTMLInputElement;
    const confirm = screen.getByRole("button", { name: "Confirm" }) as HTMLButtonElement;
    fireEvent.change(input, { target: { value: "12ab34" } });
    expect(input.value).toBe("1234");
    expect(confirm.disabled).toBe(true);
    fireEvent.change(input, { target: { value: CODE } });
    expect(confirm.disabled).toBe(false);
  });

  it("sends the code once, and says what each answer means", async () => {
    const outcomes: FreshOutcome[] = ["wrong", "limited", "failed", "unavailable"];
    const said = [
      "That code didn't work.",
      FRESH_TEXT.limited,
      "Something went wrong. Try again.",
      FRESH_TEXT.passkeysUnavailable,
    ];
    const sent: string[] = [];
    render(
      <Panel
        onCode={async (code) => {
          sent.push(code);
          return outcomes.shift() ?? "passed";
        }}
      />,
    );
    for (const text of said) {
      const input = screen.getByLabelText("Authenticator code");
      fireEvent.change(input, { target: { value: CODE } });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
      });
      expect((await screen.findByRole("alert")).textContent).toBe(text);
    }
    expect(sent).toEqual([CODE, CODE, CODE, CODE]);
  });

  it("clears the code after a wrong one", async () => {
    render(<Panel onCode={async () => "wrong"} />);
    const input = screen.getByLabelText("Authenticator code") as HTMLInputElement;
    fireEvent.change(input, { target: { value: CODE } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    });
    expect(input.value).toBe("");
  });

  it("offers a passkey when the screen says it can be used, and a passkey alone when there is no app", async () => {
    const asked: string[] = [];
    render(
      <Panel
        hasApp={false}
        passkeyUsable
        onPasskey={async () => {
          asked.push("passkey");
          return "passed";
        }}
      />,
    );
    expect(screen.queryByLabelText("Authenticator code")).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Use a passkey" }));
    });
    expect(asked).toEqual(["passkey"]);
  });

  it("says so when there is neither an app nor a passkey this browser can use", () => {
    render(<Panel hasApp={false} passkeyUsable={false} />);
    expect(
      screen.getByText("This browser can't use passkeys. Try another browser or device."),
    ).toBeTruthy();
  });

  it("while it finds out which ways there are, shows a status and Cancel only", async () => {
    const cancelled: string[] = [];
    const { container } = render(<Panel loading onCancel={() => cancelled.push("cancel")} />);
    expect(screen.getByRole("status").textContent).toContain("Checking how you confirm it's you");
    expect(screen.queryByLabelText("Authenticator code")).toBeNull();
    expect(screen.queryByRole("button", { name: "Confirm" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(cancelled).toEqual(["cancel"]);
    const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(resultIds(results)).toEqual([]);
  });
});

// ---- one component for both screens ------------------------------------------------------------

const FAMILY_ID = "00000000-0000-4000-8000-000000000001";
const ADULT_ID = "00000000-0000-4000-8000-000000000010";
const CHILD_ID = "00000000-0000-4000-8000-000000000021";

function installBoth() {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (info) => {
    const path = String(info).replace(/^https?:\/\/[^/]+/, "");
    switch (path) {
      case "/v1/access/capabilities":
        return json(200, {
          permissions: {
            "people.view": true,
            "people.manage": true,
            "people.restricted.read": true,
            "people.delete": false,
            "service_times.manage": false,
          },
          entitlements: {
            "people.directory": true,
            "people.households": true,
            "module.engagement": false,
          },
          roles: { communityAdmin: true },
        });
      case "/v1/billing/status":
        return json(200, {
          state: "ok",
          trial_end: null,
          grace_until: null,
          canView: true,
          canManage: true,
        });
      case "/v1/households/list":
        return json(200, {
          items: [{ householdId: FAMILY_ID, version: 1, label: "Clarke Family", adultCount: 1 }],
          nextCursor: null,
        });
      case "/v1/households/read":
        return json(200, {
          householdId: FAMILY_ID,
          version: 1,
          status: "active",
          label: "Clarke Family",
          adults: [{ personId: ADULT_ID, givenName: "Arthur", familyName: "Clarke", version: 1 }],
          minors: { childCount: 1, children: [{ personId: CHILD_ID, label: "Child 1" }] },
          guardians: [],
        });
      case "/v1/people/life-events/list":
        return json(200, { items: [] });
      case "/v1/people/minors/view":
        return json(403, { code: "fresh_required" });
      case "/v1/auth/second-factor":
        return json(200, {
          totp: { confirmedAt: "2026-03-04T05:06:07.000Z" },
          passkeys: [],
          backupCodesLeft: 8,
          freshUntil: null,
          recoveryUntil: null,
        });
      default:
        return new Response(null, { status: 404 });
    }
  });
}

describe("the panel is one component", () => {
  it("pin 83: Security and Family Records render the same FreshCheck", async () => {
    installBoth();

    // Settings → Security asks for it before a change to how the person signs in.
    sessionStorage.setItem(ACCESS_KEY, TOKEN);
    sessionStorage.setItem(HANDLE_KEY, TOKEN);
    await router.navigate("/settings/security");
    render(<Shell />);
    const makeCodes = await screen.findByRole("button", { name: "Make new backup codes" });
    await act(async () => {
      fireEvent.click(makeCodes);
    });
    expect(await screen.findByRole("heading", { name: "Confirm it's you", level: 2 })).toBeTruthy();
    expect(shared.renders.length).toBeGreaterThan(0);
    expect(shared.renders.every((entry) => entry.level === undefined)).toBe(true);
    const securityRenders = shared.renders.length;

    cleanup();
    sessionStorage.clear();
    await router.navigate("/");

    // The View of a child asks for it too, with the same panel one level down the page.
    sessionStorage.setItem(ACCESS_KEY, TOKEN);
    await router.navigate("/family-records");
    render(<Shell />);
    fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
      target: { value: SLUG },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));
    fireEvent.click(await screen.findByRole("button", { name: "View Clarke Family" }));
    fireEvent.click(await screen.findByRole("button", { name: "View name for Child 1" }));
    const heading = await screen.findByRole("heading", { name: "Confirm it's you", level: 4 });
    expect(heading).toBeTruthy();
    const panel = heading.closest<HTMLElement>('section[data-slot="panel"]');
    expect(panel).not.toBeNull();
    expect(await within(panel!).findByLabelText("Authenticator code")).toBeTruthy();

    expect(shared.renders.length).toBeGreaterThan(securityRenders);
    expect(shared.renders.slice(securityRenders).some((entry) => entry.level === 4)).toBe(true);
  });
});
