import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import axe from "axe-core";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BillingStatusProvider } from "./billing-status";
import { CommunityProvider } from "./community";
import {
  CONTACTS_HELP,
  CONTACTS_LABEL,
  EMERGENCY_CONTACT_RELATIONSHIPS,
  MAX_EMERGENCY_CONTACTS,
} from "./emergency-contacts-panel";
import { FamilyRecordsPage } from "./family-records";
import { type PeopleAccess, PeopleAccessContext } from "./people-access";
import { router, Shell } from "./shell";

const SLUG = "test-community";
const OTHER_SLUG = "other-parish";
const TOKEN = "synthetic.access.token";
const ID_A = "00000000-0000-4000-8000-0000000000c1";
const ID_B = "00000000-0000-4000-8000-0000000000c2";

const READ_CONTACTS = "/v1/households/emergency-contacts/read";
const SAVE_CONTACTS = "/v1/households/emergency-contacts/save";
const READ = "/v1/households/read";
const LIST = "/v1/households/list";
const RENAME = "/v1/households/rename";
const DELETE = "/v1/households/delete";
const STATUS = "/v1/households/status";
const BILLING = "/v1/billing/status";

const MSG_LOAD_FAILED = "Unable to load emergency contacts. Try again.";
const MSG_CONFLICT =
  "Someone else changed this family. Your changes are still here. Check them and save again.";
const MSG_SAVE_FAILED = "Unable to save. Try again.";
const MSG_CHECK = "Check the name and phone of each contact.";
const MSG_READ_ONLY = "Read-only until billing is settled";

type Contact = { name: string; relationship: string | null; phone: string };
type Body = Record<string, unknown>;
type Call = { path: string; url: string; body: Body };
type Handler = (body: Body) => Response | Promise<Response>;
type Options = {
  canManage?: boolean;
  canRestricted?: boolean;
  billing?: "ok" | "read_only" | "loading";
  contacts?: Contact[];
  read?: Handler;
  save?: Handler;
  detail?: Handler;
  rename?: Handler;
  status?: Handler;
};

// Synthetic people. Phones are stored as digits by the module and shown as received.
const MAYA: Contact = { name: "Maya Quill", relationship: "friend", phone: "61455555101" };
const OWEN: Contact = { name: "Owen Tarn", relationship: null, phone: "61455555102" };
const LATE: Contact = { name: "Rhea Marsh", relationship: null, phone: "61455555199" };
const TYPED_NAME = "Priya Vane";
const TYPED_PHONE = "+61 455 555 103";
const VALUES = [MAYA.name, MAYA.phone, OWEN.name, OWEN.phone, TYPED_NAME, TYPED_PHONE];

function json(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function empty(status: number): Response {
  return new Response(null, { status });
}

function deferred() {
  let release: (response: Response) => void = () => {};
  const promise = new Promise<Response>((resolve) => {
    release = resolve;
  });
  return { promise, release: (response: Response) => release(response) };
}

function resultIds(results: axe.AxeResults): string[] {
  return results.violations.map((entry) => entry.id);
}

function mockServer(options: Options = {}) {
  const calls: Call[] = [];
  const versions = new Map<string, number>();
  const labels = new Map<string, string>();
  const stored = new Map<string, Contact[]>();
  const keyOf = (body: Body) => `${String(body.communitySlug)}:${String(body.householdId)}`;
  const versionOf = (body: Body) =>
    versions.get(keyOf(body)) ?? (body.householdId === ID_A ? 3 : 5);
  const labelOf = (body: Body) =>
    labels.get(keyOf(body)) ?? (body.householdId === ID_A ? "Clarke Family" : "Webb Family");
  const contactsOf = (body: Body) => stored.get(keyOf(body)) ?? options.contacts ?? [MAYA, OWEN];

  vi.spyOn(globalThis, "fetch").mockImplementation(async (info, init) => {
    const url = String(info);
    const route = url.replace(/^https?:\/\/[^/]+/, "");
    let body: Body = {};
    if (init?.body) {
      const parsed: unknown = JSON.parse(String(init.body));
      body = typeof parsed === "object" && parsed !== null ? { ...parsed } : {};
    }
    calls.push({ path: route, url, body });

    if (route === "/v1/access/capabilities") {
      return json(200, {
        permissions: {
          "people.view": true,
          "people.manage": options.canManage ?? true,
          "people.restricted.read": options.canRestricted ?? true,
          "people.delete": true,
        },
        entitlements: { "people.directory": true, "people.households": true },
        roles: { communityAdmin: options.canRestricted ?? true },
      });
    }
    if (route === BILLING) {
      if (options.billing === "loading") {
        return new Promise<Response>(() => {});
      }
      return json(200, {
        state: options.billing ?? "ok",
        trial_end: null,
        grace_until: null,
        canView: true,
        canManage: true,
      });
    }
    if (route === LIST) {
      return json(200, {
        items: [ID_A, ID_B].map((householdId) => {
          const scope = { communitySlug: body.communitySlug, householdId };
          return {
            householdId,
            version: versionOf(scope),
            label: labelOf(scope),
            adultCount: 1,
            status: "active",
          };
        }),
        nextCursor: null,
      });
    }
    if (route === READ) {
      if (options.detail) {
        return options.detail(body);
      }
      return json(200, {
        householdId: body.householdId,
        version: versionOf(body),
        status: "active",
        label: labelOf(body),
        adults: [
          {
            personId: "00000000-0000-4000-8000-000000000010",
            givenName: "Arthur",
            familyName: "Clarke",
            version: 1,
          },
        ],
        minors: [],
        guardians: [],
      });
    }
    if (route === RENAME) {
      if (options.rename) {
        return options.rename(body);
      }
      if (body.version !== versionOf(body)) {
        return json(409, {});
      }
      const next = versionOf(body) + 1;
      versions.set(keyOf(body), next);
      if (typeof body.label === "string") {
        labels.set(keyOf(body), body.label);
      }
      return json(200, { version: next });
    }
    if (route === STATUS) {
      if (options.status) {
        return options.status(body);
      }
      const next = versionOf(body) + 1;
      versions.set(keyOf(body), next);
      return json(200, { householdId: body.householdId, version: next, status: body.status });
    }
    if (route === DELETE) {
      if (body.version !== versionOf(body)) {
        return json(409, {});
      }
      return json(200, {
        householdId: body.householdId,
        version: versionOf(body) + 1,
        purgeAfter: new Date().toISOString(),
      });
    }
    if (route === READ_CONTACTS) {
      if (options.read) {
        return options.read(body);
      }
      return json(200, {
        householdId: body.householdId,
        version: versionOf(body),
        contacts: contactsOf(body),
      });
    }
    if (route === SAVE_CONTACTS) {
      if (options.save) {
        return options.save(body);
      }
      if (body.version !== versionOf(body)) {
        return json(409, {});
      }
      const next = versionOf(body) + 1;
      versions.set(keyOf(body), next);
      stored.set(keyOf(body), body.contacts as Contact[]);
      return json(200, { householdId: body.householdId, version: next });
    }
    if (route === "/v1/people/life-events/list") {
      return json(200, { items: [] });
    }
    return empty(404);
  });
  return { calls, versions, keyOf };
}

function callsTo(calls: Call[], route: string): Call[] {
  return calls.filter((call) => call.path === route);
}

async function openScreen(options: Options = {}) {
  sessionStorage.setItem("community-hub.access-token", TOKEN);
  const server = mockServer(options);
  await router.navigate("/family-records");
  const view = render(<Shell />);
  fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
    target: { value: SLUG },
  });
  fireEvent.click(screen.getByRole("button", { name: "Set" }));
  await screen.findByRole("table", { name: "Households" });
  return { ...server, container: view.container };
}

async function resetScreen() {
  cleanup();
  sessionStorage.clear();
  vi.restoreAllMocks();
  document.documentElement.removeAttribute("data-theme");
  await router.navigate("/");
}

async function flushPending() {
  for (let turn = 0; turn < 3; turn += 1) {
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function openFamily(name = "Clarke Family") {
  fireEvent.click(await screen.findByRole("button", { name: `View ${name}` }));
  await screen.findByText("Arthur");
}

async function openFamilyWithPanel(name = "Clarke Family") {
  await openFamily(name);
  await screen.findByRole("heading", { name: "Emergency contacts" });
}

async function switchCommunity() {
  fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
    target: { value: OTHER_SLUG },
  });
  fireEvent.click(screen.getByRole("button", { name: "Set" }));
  await screen.findByRole("table", { name: "Households" });
  await flushPending();
}

function heading(): HTMLElement {
  return screen.getByRole("heading", { name: "Emergency contacts" });
}

function showButton(): HTMLElement {
  return screen.getByRole("button", { name: "Show emergency contacts" });
}

async function expectHeadingFocused() {
  await waitFor(() => expect(document.activeElement).toBe(heading()));
}

async function showLoaded() {
  fireEvent.click(showButton());
  await expectHeadingFocused();
}

function startEdit() {
  fireEvent.click(screen.getByRole("button", { name: "Edit emergency contacts" }));
}

function field(label: string): HTMLInputElement {
  return screen.getByLabelText<HTMLInputElement>(label);
}

function type(label: string, value: string) {
  fireEvent.change(field(label), { target: { value } });
}

function save() {
  fireEvent.click(screen.getByRole("button", { name: "Save emergency contacts" }));
}

async function expectAlert(text: string) {
  const alert = await screen.findByText(text);
  await waitFor(() => expect(document.activeElement).toBe(alert.closest("[role='alert']")));
}

async function renameFamily(label: string) {
  fireEvent.click(screen.getByRole("button", { name: "Rename household" }));
  fireEvent.change(await screen.findByRole("textbox", { name: "Household name" }), {
    target: { value: label },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await screen.findByRole("heading", { name: "Household Details" });
  await screen.findByText(label);
}

// A rename that is refused because someone else changed the family, then Reload: the detail reloads
// at the server's version, and nothing else on this screen has moved the contacts version.
async function reloadDetailAfterRefusedRename(calls: Call[]) {
  const reads = callsTo(calls, READ).length;
  fireEvent.click(screen.getByRole("button", { name: "Rename household" }));
  fireEvent.click(await screen.findByRole("button", { name: "Save changes" }));
  fireEvent.click(await screen.findByRole("button", { name: "Reload" }));
  await waitFor(() => expect(callsTo(calls, READ)).toHaveLength(reads + 1));
  await screen.findByRole("heading", { name: "Emergency contacts" });
  await flushPending();
}

function detailBody(householdId: unknown, version: number) {
  return {
    householdId,
    version,
    status: "active",
    label: householdId === ID_A ? "Clarke Family" : "Webb Family",
    adults: [
      {
        personId: "00000000-0000-4000-8000-000000000010",
        givenName: "Arthur",
        familyName: "Clarke",
        version: 1,
      },
    ],
    minors: [],
    guardians: [],
  };
}

function expectNoValues(values: string[], label: string) {
  for (const value of values) {
    expect(document.body.innerHTML.includes(value), `${label}: ${value}`).toBe(false);
  }
}

async function expectNoViolations(target: HTMLElement, label: string) {
  for (const theme of ["light", "dark"] as const) {
    document.documentElement.dataset.theme = theme;
    const results = await axe.run(target, { rules: { "color-contrast": { enabled: false } } });
    expect(resultIds(results), `${label} ${theme}`).toEqual([]);
  }
  document.documentElement.removeAttribute("data-theme");
}

// jsdom has no layout. A width only changes what the app asks matchMedia about, so this covers the
// narrow-viewport branch of the shell and not the real CSS at 375 px.
function setViewportWidth(width: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: query === "(max-width: 639.98px)" ? width < 640 : false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

const originalMatchMedia = window.matchMedia;
const originalInnerWidth = window.innerWidth;

beforeEach(async () => {
  sessionStorage.clear();
  await router.navigate("/");
});

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  window.matchMedia = originalMatchMedia;
  Object.defineProperty(window, "innerWidth", { configurable: true, value: originalInnerWidth });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Emergency contacts panel", () => {
  describe("copy and options", () => {
    it("the relationship list and the cap match packages/contracts", () => {
      const here = path.dirname(fileURLToPath(import.meta.url));
      const source = fs.readFileSync(
        path.resolve(here, "../../../packages/contracts/src/households.ts"),
        "utf8",
      );
      const list = /EMERGENCY_CONTACT_RELATIONSHIPS = \[([^\]]*)\] as const/.exec(source);
      expect(list).not.toBeNull();
      const values = [...(list?.[1] ?? "").matchAll(/"([a-z_]+)"/g)].map((match) => match[1]);
      expect([...EMERGENCY_CONTACT_RELATIONSHIPS]).toEqual(values);
      const cap = /MAX_EMERGENCY_CONTACTS = (\d+)/.exec(source);
      expect(MAX_EMERGENCY_CONTACTS).toBe(Number(cap?.[1]));
      const name = /const name = z\.string\(\)\.trim\(\)\.min\(1\)\.max\((\d+)\)/.exec(source);
      expect(Number(name?.[1])).toBe(100);
    });

    it("the panel says Adult to contact if guardians cannot be reached and offers no child relationship", async () => {
      await openScreen({ contacts: [] });
      await openFamilyWithPanel();
      expect(CONTACTS_LABEL).toBe("Adult to contact if guardians cannot be reached");
      expect(CONTACTS_HELP).toBe("Do not enter a child's name.");
      expect(screen.getAllByText("Adult to contact if guardians cannot be reached")).toHaveLength(
        1,
      );
      expect(screen.getAllByText("Do not enter a child's name.")).toHaveLength(1);

      await showLoaded();
      expect(screen.getAllByText("Adult to contact if guardians cannot be reached")).toHaveLength(
        1,
      );
      startEdit();
      expect(screen.getAllByText("Adult to contact if guardians cannot be reached")).toHaveLength(
        1,
      );
      expect(screen.getAllByText("Do not enter a child's name.")).toHaveLength(1);
      expect(
        screen.getByRole("group", { name: "Adult to contact if guardians cannot be reached" }),
      ).toBeTruthy();

      fireEvent.click(screen.getByRole("button", { name: "Add contact" }));
      const select = screen.getByRole<HTMLSelectElement>("combobox", {
        name: "Contact 1 relationship",
      });
      const options = Array.from(select.options);
      expect(options.map((option) => option.textContent)).toEqual([
        "None",
        "Spouse",
        "Grandparent",
        "Relative",
        "Neighbour",
        "Friend",
        "Carer",
        "Other",
      ]);
      expect(options.map((option) => option.value)).toEqual([
        "",
        ...EMERGENCY_CONTACT_RELATIONSHIPS,
      ]);
      for (const option of options) {
        expect(option.textContent).not.toMatch(/child|son|daughter|minor|kid/i);
      }
    });
  });

  describe("showing", () => {
    it("emergency contacts are not requested until Show is pressed", async () => {
      const { calls } = await openScreen();
      await openFamilyWithPanel();
      await flushPending();
      expect(callsTo(calls, READ_CONTACTS)).toHaveLength(0);
      expect(screen.queryByText("No emergency contacts.")).toBeNull();
      expect(screen.queryByText(MAYA.name)).toBeNull();

      fireEvent.click(showButton());
      await screen.findByText(MAYA.name);
      expect(callsTo(calls, READ_CONTACTS)).toHaveLength(1);
      expect(callsTo(calls, READ_CONTACTS)[0]!.body).toEqual({
        communitySlug: SLUG,
        householdId: ID_A,
      });
      await flushPending();
      expect(callsTo(calls, READ_CONTACTS)).toHaveLength(1);

      fireEvent.click(screen.getByRole("button", { name: "Hide emergency contacts" }));
      await flushPending();
      expect(callsTo(calls, READ_CONTACTS)).toHaveLength(1);
      expect(screen.queryByText(MAYA.name)).toBeNull();
      expect(showButton()).toBeTruthy();
    });

    it("the panel is not rendered without people.restricted.read", async () => {
      const { calls } = await openScreen({ canRestricted: false });
      await openFamily();
      await flushPending();
      expect(screen.queryByRole("heading", { name: "Emergency contacts" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Show emergency contacts" })).toBeNull();
      expect(screen.queryByText(CONTACTS_LABEL)).toBeNull();
      expect(callsTo(calls, READ_CONTACTS)).toHaveLength(0);
    });

    it("the panel is not rendered while the detail is loading, not found or failed", async () => {
      for (const outcome of ["loading", "not found", "failed"] as const) {
        const pending = deferred();
        const { calls } = await openScreen({
          detail: () =>
            outcome === "loading"
              ? pending.promise
              : outcome === "failed"
                ? empty(500)
                : empty(404),
        });
        fireEvent.click(await screen.findByRole("button", { name: "View Clarke Family" }));
        await waitFor(() => expect(callsTo(calls, READ)).toHaveLength(1));
        await flushPending();
        expect(screen.queryByRole("heading", { name: "Emergency contacts" }), outcome).toBeNull();
        expect(
          screen.queryByRole("button", { name: "Show emergency contacts" }),
          outcome,
        ).toBeNull();
        expect(callsTo(calls, READ_CONTACTS), outcome).toHaveLength(0);
        await resetScreen();
      }
    });

    it("shows nothing about whether contacts exist before the read answers", async () => {
      const answer = deferred();
      await openScreen({ read: () => answer.promise });
      await openFamilyWithPanel();
      fireEvent.click(showButton());
      await screen.findByText("Loading emergency contacts...");
      expect(screen.queryByText("No emergency contacts.")).toBeNull();
      expect(screen.queryByText(MAYA.name)).toBeNull();
      expect(screen.queryByRole("button", { name: "Edit emergency contacts" })).toBeNull();
      await act(async () => {
        answer.release(json(200, { householdId: ID_A, version: 3, contacts: [] }));
      });
      expect(await screen.findByText("No emergency contacts.")).toBeTruthy();
      expect(screen.queryByText("Loading emergency contacts...")).toBeNull();
    });

    it("shows the list with name, relationship and phone as received, and the empty state", async () => {
      await openScreen();
      await openFamilyWithPanel();
      await showLoaded();
      const section = heading().closest("section") as HTMLElement;
      const items = within(section).getAllByRole("listitem");
      expect(items.map((item) => item.textContent)).toEqual([
        "Maya QuillFriend61455555101",
        "Owen Tarn61455555102",
      ]);
      expect(screen.queryByText("No emergency contacts.")).toBeNull();
      await resetScreen();

      await openScreen({ contacts: [] });
      await openFamilyWithPanel();
      await showLoaded();
      expect(screen.getByText("No emergency contacts.")).toBeTruthy();
      expect(
        within(heading().closest("section") as HTMLElement).queryByRole("listitem"),
      ).toBeNull();
    });

    it("a load failure shows the message and Retry, for each kind of failure", async () => {
      const answers: [string, Handler][] = [
        ["500", () => empty(500)],
        ["404", () => empty(404)],
        ["403", () => empty(403)],
        ["network", () => Promise.reject(new TypeError("network down"))],
        ["not json", () => new Response("not json", { status: 200 })],
      ];
      for (const [label, read] of answers) {
        const { calls } = await openScreen({ read });
        await openFamilyWithPanel();
        fireEvent.click(showButton());
        expect((await screen.findByText(MSG_LOAD_FAILED)).textContent, label).toBe(MSG_LOAD_FAILED);
        expect(screen.getByRole("button", { name: "Retry" }), label).toBeTruthy();
        expect(screen.queryByText("No emergency contacts."), label).toBeNull();
        expect(callsTo(calls, READ_CONTACTS), label).toHaveLength(1);
        await resetScreen();
      }
    });

    it("an answer that does not match the contract is a load failure", async () => {
      const good = { name: MAYA.name, relationship: "friend", phone: MAYA.phone };
      const answers: [string, unknown][] = [
        [
          "unknown relationship",
          { householdId: ID_A, version: 3, contacts: [{ ...good, relationship: "son" }] },
        ],
        [
          "relationship missing",
          { householdId: ID_A, version: 3, contacts: [{ name: good.name, phone: good.phone }] },
        ],
        [
          "missing name",
          { householdId: ID_A, version: 3, contacts: [{ relationship: null, phone: good.phone }] },
        ],
        ["blank name", { householdId: ID_A, version: 3, contacts: [{ ...good, name: "  " }] }],
        [
          "missing phone",
          { householdId: ID_A, version: 3, contacts: [{ name: good.name, relationship: null }] },
        ],
        [
          "six contacts",
          { householdId: ID_A, version: 3, contacts: Array.from({ length: 6 }, () => good) },
        ],
        ["another household", { householdId: ID_B, version: 3, contacts: [good] }],
        ["no version", { householdId: ID_A, contacts: [good] }],
        ["contacts not a list", { householdId: ID_A, version: 3, contacts: "none" }],
      ];
      for (const [label, answer] of answers) {
        await openScreen({ read: () => json(200, answer) });
        await openFamilyWithPanel();
        fireEvent.click(showButton());
        await screen.findByText(MSG_LOAD_FAILED);
        expect(screen.queryByText(MAYA.name), label).toBeNull();
        expect(screen.queryByText(MAYA.phone), label).toBeNull();
        expect(screen.queryByText("No emergency contacts."), label).toBeNull();
        await resetScreen();
      }
    });

    it("Retry reads again and shows the list", async () => {
      let attempts = 0;
      const { calls } = await openScreen({
        read: (body) => {
          attempts += 1;
          return attempts === 1
            ? empty(500)
            : json(200, { householdId: body.householdId, version: 3, contacts: [MAYA] });
        },
      });
      await openFamilyWithPanel();
      fireEvent.click(showButton());
      await screen.findByText(MSG_LOAD_FAILED);
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      await screen.findByText(MAYA.name);
      expect(screen.queryByText(MSG_LOAD_FAILED)).toBeNull();
      expect(callsTo(calls, READ_CONTACTS)).toHaveLength(2);
      await expectHeadingFocused();
    });
  });

  describe("editing", () => {
    it("Edit is not rendered without people.manage", async () => {
      await openScreen({ canManage: false });
      await openFamilyWithPanel();
      await showLoaded();
      expect(screen.getByText(MAYA.name)).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Edit emergency contacts" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    });

    it("Edit is not rendered in a read-only community or while billing loads", async () => {
      for (const billing of ["read_only", "loading"] as const) {
        await openScreen({ billing });
        await openFamilyWithPanel();
        await showLoaded();
        expect(screen.getByText(MAYA.name), billing).toBeTruthy();
        expect(
          screen.queryByRole("button", { name: "Edit emergency contacts" }),
          billing,
        ).toBeNull();
        await resetScreen();
      }
    });

    it("Edit moves focus to the first field, or to Add when there are no contacts", async () => {
      await openScreen();
      await openFamilyWithPanel();
      await showLoaded();
      startEdit();
      await waitFor(() => expect(document.activeElement).toBe(field("Contact 1 name")));
      expect(field("Contact 1 name").value).toBe(MAYA.name);
      expect(field("Contact 2 phone").value).toBe(OWEN.phone);
      await resetScreen();

      await openScreen({ contacts: [] });
      await openFamilyWithPanel();
      await showLoaded();
      startEdit();
      await waitFor(() =>
        expect(document.activeElement).toBe(screen.getByRole("button", { name: "Add contact" })),
      );
    });

    it("Add puts the new row's name in focus and stops at five", async () => {
      await openScreen({ contacts: [] });
      await openFamilyWithPanel();
      await showLoaded();
      startEdit();
      for (let number = 1; number <= MAX_EMERGENCY_CONTACTS; number += 1) {
        expect(screen.getByRole("button", { name: "Add contact" })).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "Add contact" }));
        await waitFor(() => expect(document.activeElement).toBe(field(`Contact ${number} name`)));
      }
      expect(screen.queryByRole("button", { name: "Add contact" })).toBeNull();
      expect(screen.getAllByRole("button", { name: /^Remove contact \d$/ })).toHaveLength(5);
    });

    it("Remove names the row by number, and moves focus to the next Remove or to Add", async () => {
      await openScreen({
        contacts: [MAYA, OWEN, { name: "Lena Marsh", relationship: "carer", phone: "61455555104" }],
      });
      await openFamilyWithPanel();
      await showLoaded();
      startEdit();
      const names = screen
        .getAllByRole("button", { name: /^Remove contact \d$/ })
        .map((button) => button.getAttribute("aria-label"));
      expect(names).toEqual(["Remove contact 1", "Remove contact 2", "Remove contact 3"]);

      fireEvent.click(screen.getByRole("button", { name: "Remove contact 2" }));
      await waitFor(() =>
        expect(document.activeElement).toBe(
          screen.getByRole("button", { name: "Remove contact 2" }),
        ),
      );
      expect(field("Contact 2 name").value).toBe("Lena Marsh");
      expect(screen.queryByLabelText("Contact 3 name")).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "Remove contact 2" }));
      await waitFor(() =>
        expect(document.activeElement).toBe(screen.getByRole("button", { name: "Add contact" })),
      );
      expect(field("Contact 1 name").value).toBe(MAYA.name);
    });

    it("Cancel drops the typed rows, shows the last known list and moves focus to Edit", async () => {
      const { calls } = await openScreen();
      await openFamilyWithPanel();
      await showLoaded();
      startEdit();
      type("Contact 1 name", TYPED_NAME);
      fireEvent.click(screen.getByRole("button", { name: "Add contact" }));
      type("Contact 3 name", "Zed Hollis");
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      await waitFor(() =>
        expect(document.activeElement).toBe(
          screen.getByRole("button", { name: "Edit emergency contacts" }),
        ),
      );
      expect(screen.getByText(MAYA.name)).toBeTruthy();
      expect(screen.queryByText(TYPED_NAME)).toBeNull();
      expect(screen.queryByText("Zed Hollis")).toBeNull();
      expect(callsTo(calls, READ_CONTACTS)).toHaveLength(1);
      expect(callsTo(calls, SAVE_CONTACTS)).toHaveLength(0);
      startEdit();
      expect(field("Contact 1 name").value).toBe(MAYA.name);
      expect(screen.queryByLabelText("Contact 3 name")).toBeNull();
    });

    it("the inputs have labels per row, autocomplete off, type tel and a name limit", async () => {
      await openScreen();
      await openFamilyWithPanel();
      await showLoaded();
      startEdit();
      for (const number of [1, 2]) {
        const name = field(`Contact ${number} name`);
        const phone = field(`Contact ${number} phone`);
        const relationship = screen.getByRole<HTMLSelectElement>("combobox", {
          name: `Contact ${number} relationship`,
        });
        expect(name.getAttribute("autocomplete")).toBe("off");
        expect(name.maxLength).toBe(100);
        expect(phone.getAttribute("autocomplete")).toBe("off");
        expect(phone.type).toBe("tel");
        expect(relationship.getAttribute("autocomplete")).toBe("off");
      }
      expect(field("Contact 1 name").value).toBe(MAYA.name);
      expect(
        screen.getByRole<HTMLSelectElement>("combobox", { name: "Contact 1 relationship" }).value,
      ).toBe("friend");
      expect(
        screen.getByRole<HTMLSelectElement>("combobox", { name: "Contact 2 relationship" }).value,
      ).toBe("");
    });
  });

  describe("client checks", () => {
    async function editTwo() {
      const server = await openScreen();
      await openFamilyWithPanel();
      await showLoaded();
      startEdit();
      return server;
    }

    function expectErrorLinked(label: string, message: string) {
      const input = field(label);
      expect(input.getAttribute("aria-invalid")).toBe("true");
      const ids = (input.getAttribute("aria-describedby") ?? "").split(" ");
      const texts = ids.map((id) => document.getElementById(id)?.textContent);
      expect(texts).toContain(message);
    }

    it("a missing name stops the save, focuses the field and links the error", async () => {
      const { calls } = await editTwo();
      type("Contact 2 name", "   ");
      save();
      await waitFor(() => expect(document.activeElement).toBe(field("Contact 2 name")));
      expectErrorLinked("Contact 2 name", "Enter a name.");
      expect(callsTo(calls, SAVE_CONTACTS)).toHaveLength(0);
      expect(field("Contact 1 name").getAttribute("aria-invalid")).toBeNull();
    });

    it("a name over 100 characters stops the save", async () => {
      const { calls } = await editTwo();
      type("Contact 1 name", "n".repeat(101));
      save();
      await waitFor(() => expect(document.activeElement).toBe(field("Contact 1 name")));
      expectErrorLinked("Contact 1 name", "Name must be 100 characters or fewer.");
      expect(callsTo(calls, SAVE_CONTACTS)).toHaveLength(0);
    });

    it("a missing phone stops the save, and the first bad field in row order gets the focus", async () => {
      const { calls } = await editTwo();
      type("Contact 2 name", "");
      type("Contact 1 phone", " ");
      save();
      await waitFor(() => expect(document.activeElement).toBe(field("Contact 1 phone")));
      expectErrorLinked("Contact 1 phone", "Enter a phone number.");
      expectErrorLinked("Contact 2 name", "Enter a name.");
      expect(callsTo(calls, SAVE_CONTACTS)).toHaveLength(0);

      type("Contact 1 phone", MAYA.phone);
      expect(field("Contact 1 phone").getAttribute("aria-invalid")).toBeNull();
      type("Contact 2 name", OWEN.name);
      save();
      await waitFor(() => expect(callsTo(calls, SAVE_CONTACTS)).toHaveLength(1));
    });
  });

  describe("saving", () => {
    it("Save sends the version and every row in order, trimmed, with relationship null when none", async () => {
      const { calls } = await openScreen();
      await openFamilyWithPanel();
      await showLoaded();
      startEdit();
      type("Contact 1 name", `  ${TYPED_NAME}  `);
      type("Contact 1 phone", `  ${TYPED_PHONE} `);
      fireEvent.change(screen.getByRole("combobox", { name: "Contact 1 relationship" }), {
        target: { value: "" },
      });
      fireEvent.change(screen.getByRole("combobox", { name: "Contact 2 relationship" }), {
        target: { value: "neighbour" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Add contact" }));
      type("Contact 3 name", "Zed Hollis");
      type("Contact 3 phone", "61455555105");
      save();
      await screen.findByText(TYPED_NAME);
      expect(callsTo(calls, SAVE_CONTACTS)).toHaveLength(1);
      expect(callsTo(calls, SAVE_CONTACTS)[0]!.body).toEqual({
        communitySlug: SLUG,
        householdId: ID_A,
        version: 3,
        contacts: [
          { name: TYPED_NAME, relationship: null, phone: TYPED_PHONE },
          { name: OWEN.name, relationship: "neighbour", phone: OWEN.phone },
          { name: "Zed Hollis", relationship: null, phone: "61455555105" },
        ],
      });
    });

    it("a saved list is shown without a second read, focus goes to the heading and Edit returns", async () => {
      const { calls } = await openScreen();
      await openFamilyWithPanel();
      await showLoaded();
      startEdit();
      type("Contact 1 name", TYPED_NAME);
      const detailReads = callsTo(calls, READ).length;
      save();
      await screen.findByText(TYPED_NAME);
      await expectHeadingFocused();
      expect(screen.queryByText(MAYA.name)).toBeNull();
      expect(screen.getByRole("button", { name: "Edit emergency contacts" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Save emergency contacts" })).toBeNull();
      await flushPending();
      expect(callsTo(calls, READ_CONTACTS)).toHaveLength(1);
      expect(callsTo(calls, READ)).toHaveLength(detailReads);
    });

    it("an empty list saves as an empty array", async () => {
      const { calls } = await openScreen();
      await openFamilyWithPanel();
      await showLoaded();
      startEdit();
      fireEvent.click(screen.getByRole("button", { name: "Remove contact 1" }));
      fireEvent.click(screen.getByRole("button", { name: "Remove contact 1" }));
      save();
      await screen.findByText("No emergency contacts.");
      expect(callsTo(calls, SAVE_CONTACTS)[0]!.body.contacts).toEqual([]);
    });

    it("after a save the family's other actions send the new version", async () => {
      const { calls } = await openScreen();
      await openFamilyWithPanel();
      await showLoaded();
      startEdit();
      type("Contact 1 name", TYPED_NAME);
      save();
      await screen.findByText(TYPED_NAME);

      fireEvent.click(screen.getByRole("button", { name: "Rename household" }));
      fireEvent.change(await screen.findByRole("textbox", { name: "Household name" }), {
        target: { value: "Quill Family" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
      await screen.findByText("Quill Family");
      expect(callsTo(calls, RENAME)).toHaveLength(1);
      expect(callsTo(calls, RENAME)[0]!.body.version).toBe(4);
    });

    it("after a save Delete family sends the new version", async () => {
      const { calls } = await openScreen();
      await openFamilyWithPanel();
      await showLoaded();
      startEdit();
      type("Contact 1 name", TYPED_NAME);
      save();
      await screen.findByText(TYPED_NAME);

      fireEvent.click(screen.getByRole("button", { name: "Delete family" }));
      const dialog = await screen.findByRole("dialog");
      fireEvent.click(within(dialog).getByRole("button", { name: "Delete family" }));
      await waitFor(() => expect(callsTo(calls, DELETE)).toHaveLength(1));
      expect(callsTo(calls, DELETE)[0]!.body.version).toBe(4);
    });

    it("Save is disabled while its own request is open and sends once", async () => {
      const answer = deferred();
      const { calls } = await openScreen({ save: () => answer.promise });
      await openFamilyWithPanel();
      await showLoaded();
      startEdit();
      type("Contact 1 name", TYPED_NAME);
      const button = screen.getByRole("button", { name: "Save emergency contacts" });
      fireEvent.click(button);
      await waitFor(() => expect(callsTo(calls, SAVE_CONTACTS)).toHaveLength(1));
      expect((button as HTMLButtonElement).disabled).toBe(true);
      expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(
        true,
      );
      fireEvent.click(button);
      fireEvent.submit(button.closest("form")!);
      await flushPending();
      expect(callsTo(calls, SAVE_CONTACTS)).toHaveLength(1);
      await act(async () => {
        answer.release(json(200, { householdId: ID_A, version: 4 }));
      });
      await screen.findByText(TYPED_NAME);
      expect(callsTo(calls, SAVE_CONTACTS)).toHaveLength(1);
    });
  });

  describe("versions", () => {
    it("save sends the family's newest version after a rename", async () => {
      const { calls } = await openScreen();
      await openFamilyWithPanel();
      await showLoaded();
      await renameFamily("Quill Family");
      await screen.findByRole("heading", { name: "Emergency contacts" });
      // The contacts answer carried version 3; the rename of this screen moved the family to 4.
      startEdit();
      type("Contact 1 name", TYPED_NAME);
      save();
      await waitFor(() => expect(callsTo(calls, SAVE_CONTACTS)).toHaveLength(1));
      expect(callsTo(calls, SAVE_CONTACTS)[0]!.body.version).toBe(4);
      await screen.findByText(TYPED_NAME);
      expect(callsTo(calls, READ_CONTACTS)).toHaveLength(1);
    });

    it("a save after a detail reload that brought someone else's version answers 409 first", async () => {
      const { calls, versions } = await openScreen();
      await openFamilyWithPanel();
      await showLoaded();
      // Someone else saves other contacts (version 4); an action of this screen reloads the detail.
      versions.set(`${SLUG}:${ID_A}`, 4);
      await reloadDetailAfterRefusedRename(calls);
      startEdit();
      type("Contact 1 name", TYPED_NAME);
      save();
      await waitFor(() => expect(callsTo(calls, SAVE_CONTACTS)).toHaveLength(1));
      expect(callsTo(calls, SAVE_CONTACTS)[0]!.body.version).toBe(3);
      await expectAlert(MSG_CONFLICT);
      expect(field("Contact 1 name").value).toBe(TYPED_NAME);
      await screen.findByText("Saved now");
      expect(callsTo(calls, READ_CONTACTS)).toHaveLength(2);

      // The person has been shown what is stored: the next Save sends the version of that read.
      save();
      await waitFor(() => expect(callsTo(calls, SAVE_CONTACTS)).toHaveLength(2));
      expect(callsTo(calls, SAVE_CONTACTS)[1]!.body.version).toBe(4);
      await screen.findByText(TYPED_NAME);
      expect(callsTo(calls, READ_CONTACTS)).toHaveLength(2);
    });

    it("a rename on top of someone else's change does not move the contacts version", async () => {
      const { calls, versions } = await openScreen();
      await openFamilyWithPanel();
      await showLoaded();
      versions.set(`${SLUG}:${ID_A}`, 4);
      await reloadDetailAfterRefusedRename(calls);
      // The detail is at 4; the rename answers 5, which is not the contacts version plus one.
      await renameFamily("Quill Family");
      await screen.findByRole("heading", { name: "Emergency contacts" });
      expect(callsTo(calls, RENAME).at(-1)!.body.version).toBe(4);
      startEdit();
      type("Contact 1 name", TYPED_NAME);
      save();
      await waitFor(() => expect(callsTo(calls, SAVE_CONTACTS)).toHaveLength(1));
      expect(callsTo(calls, SAVE_CONTACTS)[0]!.body.version).toBe(3);
      await expectAlert(MSG_CONFLICT);
      expect(field("Contact 1 name").value).toBe(TYPED_NAME);
    });

    it("a status answer of this family that returns the next version moves the contacts version", async () => {
      const answer = deferred();
      const { calls, versions } = await openScreen({ status: () => answer.promise });
      fireEvent.click(screen.getByRole("switch", { name: "Active status for Clarke Family" }));
      await waitFor(() => expect(callsTo(calls, STATUS)).toHaveLength(1));
      await openFamilyWithPanel();
      await showLoaded();
      versions.set(`${SLUG}:${ID_A}`, 4);
      await act(async () => {
        answer.release(json(200, { householdId: ID_A, version: 4, status: "inactive" }));
      });
      await flushPending();
      startEdit();
      type("Contact 1 name", TYPED_NAME);
      save();
      await waitFor(() => expect(callsTo(calls, SAVE_CONTACTS)).toHaveLength(1));
      expect(callsTo(calls, SAVE_CONTACTS)[0]!.body.version).toBe(4);
      await screen.findByText(TYPED_NAME);
    });

    it("Save is not available until the read after a conflict has answered", async () => {
      const stored = deferred();
      let reads = 0;
      const { calls, versions } = await openScreen({
        read: (body) => {
          reads += 1;
          return reads === 2
            ? stored.promise
            : json(200, { householdId: body.householdId, version: 3, contacts: [MAYA, OWEN] });
        },
      });
      await openFamilyWithPanel();
      await showLoaded();
      versions.set(`${SLUG}:${ID_A}`, 4);
      startEdit();
      type("Contact 1 name", TYPED_NAME);
      save();
      await waitFor(() => expect(callsTo(calls, SAVE_CONTACTS)).toHaveLength(1));
      await waitFor(() => expect(reads).toBe(2));
      await flushPending();
      expect(callsTo(calls, READ_CONTACTS)).toHaveLength(2);
      const waiting = screen.queryByRole<HTMLButtonElement>("button", {
        name: "Save emergency contacts",
      });
      expect(waiting === null || waiting.disabled).toBe(true);
      expect(screen.queryByText("Saved now")).toBeNull();
      expect(callsTo(calls, SAVE_CONTACTS)).toHaveLength(1);

      await act(async () => {
        stored.release(json(200, { householdId: ID_A, version: 4, contacts: [OWEN] }));
      });
      await expectAlert(MSG_CONFLICT);
      expect(field("Contact 1 name").value).toBe(TYPED_NAME);
      const button = screen.getByRole<HTMLButtonElement>("button", {
        name: "Save emergency contacts",
      });
      expect(button.disabled).toBe(false);
      fireEvent.click(button);
      await waitFor(() => expect(callsTo(calls, SAVE_CONTACTS)).toHaveLength(2));
      expect(callsTo(calls, SAVE_CONTACTS)[1]!.body.version).toBe(4);
    });

    it("a save after a conflict shows the saved contacts and sends their version", async () => {
      const stored = { version: 3, contacts: [MAYA, OWEN] };
      const { calls, versions } = await openScreen({
        read: (body) =>
          json(200, {
            householdId: body.householdId,
            version: stored.version,
            contacts: stored.contacts,
          }),
      });
      await openFamilyWithPanel();
      await showLoaded();
      // Someone else saves a different list (version 4) while this screen has the old one.
      stored.version = 4;
      stored.contacts = [OWEN];
      versions.set(`${SLUG}:${ID_A}`, 4);
      startEdit();
      type("Contact 1 name", TYPED_NAME);
      const contactReads = callsTo(calls, READ_CONTACTS).length;
      save();
      await expectAlert(MSG_CONFLICT);
      await screen.findByText("Saved now");
      // One contacts read for the conflict, and the typed rows were not replaced by it.
      expect(callsTo(calls, READ_CONTACTS)).toHaveLength(contactReads + 1);
      expect(field("Contact 1 name").value).toBe(TYPED_NAME);
      const saved = screen.getByText("Saved now").parentElement as HTMLElement;
      expect(within(saved).getByText(OWEN.name)).toBeTruthy();
      expect(within(saved).getByText(OWEN.phone)).toBeTruthy();
      expect(within(saved).queryByText(MAYA.name)).toBeNull();
      expect(saved.closest("section")).toBe(heading().closest("section"));

      save();
      await waitFor(() => expect(callsTo(calls, SAVE_CONTACTS)).toHaveLength(2));
      expect(callsTo(calls, SAVE_CONTACTS)[0]!.body.version).toBe(3);
      expect(callsTo(calls, SAVE_CONTACTS)[1]!.body.version).toBe(4);
      await screen.findByText(TYPED_NAME);
      expect(screen.queryByText("Saved now")).toBeNull();
      expect(callsTo(calls, READ_CONTACTS)).toHaveLength(contactReads + 1);
    });

    it("Saved now says there are no emergency contacts when the stored list is empty", async () => {
      const stored = { version: 3, contacts: [MAYA, OWEN] };
      const { versions } = await openScreen({
        read: (body) =>
          json(200, {
            householdId: body.householdId,
            version: stored.version,
            contacts: stored.contacts,
          }),
      });
      await openFamilyWithPanel();
      await showLoaded();
      stored.version = 4;
      stored.contacts = [];
      versions.set(`${SLUG}:${ID_A}`, 4);
      startEdit();
      type("Contact 1 name", TYPED_NAME);
      save();
      await expectAlert(MSG_CONFLICT);
      const saved = (await screen.findByText("Saved now")).parentElement as HTMLElement;
      expect(within(saved).getByText("No emergency contacts.")).toBeTruthy();
    });

    it("a failed read after a conflict shows the load failure and keeps Save unavailable until Retry answers", async () => {
      let reads = 0;
      const { calls, versions } = await openScreen({
        read: (body) => {
          reads += 1;
          if (reads === 2) {
            return empty(500);
          }
          return json(200, {
            householdId: body.householdId,
            version: reads === 1 ? 3 : 4,
            contacts: reads === 1 ? [MAYA, OWEN] : [OWEN],
          });
        },
      });
      await openFamilyWithPanel();
      await showLoaded();
      versions.set(`${SLUG}:${ID_A}`, 4);
      startEdit();
      type("Contact 1 name", TYPED_NAME);
      save();
      await screen.findByText(MSG_LOAD_FAILED);
      const section = heading().closest("section") as HTMLElement;
      expect(within(section).getByText(MSG_LOAD_FAILED)).toBeTruthy();
      expect(field("Contact 1 name").value).toBe(TYPED_NAME);
      expect(screen.queryByText("Saved now")).toBeNull();
      const stuck = screen.queryByRole<HTMLButtonElement>("button", {
        name: "Save emergency contacts",
      });
      expect(stuck === null || stuck.disabled).toBe(true);
      expect(callsTo(calls, SAVE_CONTACTS)).toHaveLength(1);

      fireEvent.click(within(section).getByRole("button", { name: "Retry" }));
      await screen.findByText("Saved now");
      expect(screen.queryByText(MSG_LOAD_FAILED)).toBeNull();
      expect(field("Contact 1 name").value).toBe(TYPED_NAME);
      save();
      await waitFor(() => expect(callsTo(calls, SAVE_CONTACTS)).toHaveLength(2));
      expect(callsTo(calls, SAVE_CONTACTS)[1]!.body.version).toBe(4);
    });

    it("a failed detail reload after a conflict keeps the rows, and Save sends the version of the read", async () => {
      let reads = 0;
      const stored = { version: 3 };
      const { calls, versions } = await openScreen({
        detail: (body) => {
          reads += 1;
          return reads === 2
            ? empty(500)
            : json(200, detailBody(body.householdId, reads === 1 ? 3 : 4));
        },
        read: (body) =>
          json(200, { householdId: body.householdId, version: stored.version, contacts: [OWEN] }),
      });
      await openFamilyWithPanel();
      await showLoaded();
      stored.version = 4;
      versions.set(`${SLUG}:${ID_A}`, 4);
      startEdit();
      type("Contact 1 name", TYPED_NAME);
      save();
      await screen.findByText("Failed to load household");
      expect(callsTo(calls, SAVE_CONTACTS)).toHaveLength(1);
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      await expectAlert(MSG_CONFLICT);
      expect(field("Contact 1 name").value).toBe(TYPED_NAME);
      await screen.findByText("Saved now");
      save();
      await waitFor(() => expect(callsTo(calls, SAVE_CONTACTS)).toHaveLength(2));
      expect(callsTo(calls, SAVE_CONTACTS)[1]!.body.version).toBe(4);
    });

    it("a 404 on the read after a conflict is the not-found path", async () => {
      let gone = false;
      const { calls, versions } = await openScreen({
        read: (body) =>
          gone
            ? empty(404)
            : json(200, { householdId: body.householdId, version: 3, contacts: [MAYA, OWEN] }),
        save: () => {
          gone = true;
          return json(409, {});
        },
        detail: (body) => (gone ? empty(404) : json(200, detailBody(body.householdId, 3))),
      });
      await openFamilyWithPanel();
      await showLoaded();
      versions.set(`${SLUG}:${ID_A}`, 4);
      startEdit();
      type("Contact 1 name", TYPED_NAME);
      save();
      await screen.findByText("Household not found");
      expect(screen.queryByRole("heading", { name: "Emergency contacts" })).toBeNull();
      expect(callsTo(calls, READ_CONTACTS)).toHaveLength(2);
      expectNoValues(VALUES, "after a 404 on the read");
    });

    it("a late answer of the read after a conflict changes nothing after Hide, another family or a community change", async () => {
      for (const leave of ["hide", "family", "community"] as const) {
        const stored = deferred();
        let reads = 0;
        const { calls } = await openScreen({
          read: (body) => {
            reads += 1;
            return reads === 2
              ? stored.promise
              : json(200, { householdId: body.householdId, version: 3, contacts: [MAYA, OWEN] });
          },
          save: () => json(409, {}),
        });
        await openFamilyWithPanel();
        await showLoaded();
        startEdit();
        type("Contact 1 name", TYPED_NAME);
        save();
        await waitFor(() => expect(reads, leave).toBe(2));
        await flushPending();
        await screen.findByRole("heading", { name: "Emergency contacts" });
        if (leave === "hide") {
          fireEvent.click(screen.getByRole("button", { name: "Hide emergency contacts" }));
          // Show and Edit again: the late answer must not appear in this new editing session.
          await showLoaded();
          startEdit();
        } else if (leave === "family") {
          fireEvent.click(screen.getByRole("button", { name: "Back to list" }));
          await openFamilyWithPanel("Webb Family");
        } else {
          await switchCommunity();
        }
        const saves = callsTo(calls, SAVE_CONTACTS).length;
        await act(async () => {
          stored.release(json(200, { householdId: ID_A, version: 9, contacts: [LATE] }));
        });
        await flushPending();
        expect(screen.queryByText("Saved now"), leave).toBeNull();
        expectNoValues([LATE.name, LATE.phone], leave);
        expect(callsTo(calls, SAVE_CONTACTS), leave).toHaveLength(saves);
        await resetScreen();
      }
    });

    it("Cancel ends the state after a conflict, and the next Save sends the known version", async () => {
      const { calls, versions } = await openScreen();
      await openFamilyWithPanel();
      await showLoaded();
      versions.set(`${SLUG}:${ID_A}`, 4);
      startEdit();
      type("Contact 1 name", TYPED_NAME);
      save();
      await expectAlert(MSG_CONFLICT);
      await screen.findByText("Saved now");
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(screen.queryByText("Saved now")).toBeNull();
      startEdit();
      expect(screen.queryByText("Saved now")).toBeNull();
      type("Contact 1 name", TYPED_NAME);
      save();
      await waitFor(() => expect(callsTo(calls, SAVE_CONTACTS)).toHaveLength(2));
      expect(callsTo(calls, SAVE_CONTACTS)[1]!.body.version).toBe(3);
    });

    it("a save after someone else's change answers 409, keeps the rows, reads the stored list once and then works", async () => {
      const { calls, versions } = await openScreen();
      await openFamilyWithPanel();
      await showLoaded();
      versions.set(`${SLUG}:${ID_A}`, 4);
      startEdit();
      type("Contact 1 name", TYPED_NAME);
      const detailReads = callsTo(calls, READ).length;
      save();
      await expectAlert(MSG_CONFLICT);
      expect(callsTo(calls, SAVE_CONTACTS)[0]!.body.version).toBe(3);
      expect(field("Contact 1 name").value).toBe(TYPED_NAME);
      // The detail reloads, and the stored list is read once (audited, as every read).
      expect(callsTo(calls, READ)).toHaveLength(detailReads + 1);
      await screen.findByText("Saved now");
      expect(callsTo(calls, READ_CONTACTS)).toHaveLength(2);

      save();
      await screen.findByText(TYPED_NAME);
      expect(callsTo(calls, SAVE_CONTACTS)).toHaveLength(2);
      expect(callsTo(calls, SAVE_CONTACTS)[1]!.body.version).toBe(4);
      expect(callsTo(calls, READ_CONTACTS)).toHaveLength(2);
    });
  });

  describe("save failures", () => {
    it("a conflict or a network failure keeps the typed contacts", async () => {
      for (const failure of ["conflict", "network"] as const) {
        const { calls } = await openScreen({
          save: () =>
            failure === "conflict" ? json(409, {}) : Promise.reject(new TypeError("network down")),
        });
        await openFamilyWithPanel();
        await showLoaded();
        startEdit();
        type("Contact 1 name", TYPED_NAME);
        fireEvent.click(screen.getByRole("button", { name: "Add contact" }));
        type("Contact 3 name", "Zed Hollis");
        type("Contact 3 phone", "61455555105");
        save();
        await expectAlert(failure === "conflict" ? MSG_CONFLICT : MSG_SAVE_FAILED);
        expect(field("Contact 1 name").value, failure).toBe(TYPED_NAME);
        expect(field("Contact 3 name").value, failure).toBe("Zed Hollis");
        expect(field("Contact 3 phone").value, failure).toBe("61455555105");
        expect(
          screen.getByRole("button", { name: "Save emergency contacts" }),
          failure,
        ).toBeTruthy();
        expect(callsTo(calls, SAVE_CONTACTS), failure).toHaveLength(1);
        await resetScreen();
      }
    });

    it("another answer shows Unable to save, a 400 asks to check the name and phone", async () => {
      const answers: [string, Handler, string][] = [
        ["500", () => empty(500), MSG_SAVE_FAILED],
        ["403", () => empty(403), MSG_SAVE_FAILED],
        ["200 without a version", () => json(200, {}), MSG_SAVE_FAILED],
        [
          "200 for another family",
          () => json(200, { householdId: ID_B, version: 4 }),
          MSG_SAVE_FAILED,
        ],
        ["400", () => json(400, {}), MSG_CHECK],
      ];
      for (const [label, save, message] of answers) {
        const { calls } = await openScreen({ save });
        await openFamilyWithPanel();
        await showLoaded();
        startEdit();
        type("Contact 1 name", TYPED_NAME);
        fireEvent.click(screen.getByRole("button", { name: "Save emergency contacts" }));
        await expectAlert(message);
        expect(field("Contact 1 name").value, label).toBe(TYPED_NAME);
        expect(callsTo(calls, SAVE_CONTACTS), label).toHaveLength(1);
        await resetScreen();
      }
    });

    it("a 402 shows the read-only message of the screen", async () => {
      const { calls } = await openScreen({ save: () => json(402, {}) });
      await openFamilyWithPanel();
      await showLoaded();
      startEdit();
      type("Contact 1 name", TYPED_NAME);
      const billingCalls = callsTo(calls, BILLING).length;
      save();
      await screen.findAllByText(MSG_READ_ONLY);
      await waitFor(() => expect(callsTo(calls, BILLING).length).toBe(billingCalls + 1));
      // The panel itself says it, not only the banner of the screen.
      const section = heading().closest("section") as HTMLElement;
      expect(within(section).getByText(MSG_READ_ONLY)).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Edit emergency contacts" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Save emergency contacts" })).toBeNull();
      expect(screen.queryByText(TYPED_NAME)).toBeNull();
    });

    it("a 404 closes the panel and reloads the detail", async () => {
      let gone = false;
      const { calls } = await openScreen({
        save: () => {
          gone = true;
          return empty(404);
        },
        detail: (body) =>
          gone
            ? empty(404)
            : json(200, {
                householdId: body.householdId,
                version: 3,
                status: "active",
                label: "Clarke Family",
                adults: [
                  {
                    personId: "00000000-0000-4000-8000-000000000010",
                    givenName: "Arthur",
                    familyName: "Clarke",
                    version: 1,
                  },
                ],
                minors: [],
                guardians: [],
              }),
      });
      await openFamilyWithPanel();
      await showLoaded();
      startEdit();
      type("Contact 1 name", TYPED_NAME);
      const detailReads = callsTo(calls, READ).length;
      save();
      await screen.findByText("Household not found");
      expect(callsTo(calls, READ)).toHaveLength(detailReads + 1);
      expect(screen.queryByRole("heading", { name: "Emergency contacts" })).toBeNull();
      expectNoValues(VALUES, "after a 404");
    });
  });

  describe("privacy", () => {
    async function withTypedRow() {
      const server = await openScreen();
      await openFamilyWithPanel();
      await showLoaded();
      startEdit();
      fireEvent.click(screen.getByRole("button", { name: "Add contact" }));
      type("Contact 3 name", TYPED_NAME);
      type("Contact 3 phone", TYPED_PHONE);
      return server;
    }

    it("Hide drops the contacts and the typed rows, and a late answer shows nothing", async () => {
      const answer = deferred();
      let reads = 0;
      const { calls } = await openScreen({
        read: (body) => {
          reads += 1;
          return reads === 2
            ? answer.promise
            : json(200, { householdId: body.householdId, version: 3, contacts: [MAYA, OWEN] });
        },
      });
      await openFamilyWithPanel();
      await showLoaded();
      startEdit();
      fireEvent.click(screen.getByRole("button", { name: "Add contact" }));
      type("Contact 3 name", TYPED_NAME);
      fireEvent.click(screen.getByRole("button", { name: "Hide emergency contacts" }));
      await flushPending();
      expectNoValues(VALUES, "after Hide");
      expect(showButton()).toBeTruthy();

      // Show again, then Hide while the read is open: the late answer changes nothing.
      fireEvent.click(showButton());
      await waitFor(() => expect(callsTo(calls, READ_CONTACTS)).toHaveLength(2));
      fireEvent.click(screen.getByRole("button", { name: "Hide emergency contacts" }));
      await act(async () => {
        answer.release(json(200, { householdId: ID_A, version: 3, contacts: [MAYA] }));
      });
      await flushPending();
      expectNoValues(VALUES, "after a late answer");
      expect(showButton()).toBeTruthy();
      expect(callsTo(calls, READ_CONTACTS)).toHaveLength(2);

      // Show once more: the server's list, never the typed row.
      fireEvent.click(showButton());
      await screen.findByText(MAYA.name);
      expect(screen.queryByText(TYPED_NAME)).toBeNull();
      expect(screen.queryByRole("button", { name: "Save emergency contacts" })).toBeNull();
    });

    it("closing the panel or changing community drops the contacts", async () => {
      // Closing Family Details.
      const first = await withTypedRow();
      fireEvent.click(screen.getByRole("button", { name: "Back to list" }));
      await screen.findByRole("table", { name: "Households" });
      expectNoValues(VALUES, "after Back to list");
      await openFamilyWithPanel();
      expectNoValues(VALUES, "after reopening");
      expect(showButton()).toBeTruthy();
      await flushPending();
      expect(callsTo(first.calls, READ_CONTACTS)).toHaveLength(1);
      await resetScreen();

      // Changing community.
      const second = await withTypedRow();
      await switchCommunity();
      expectNoValues(VALUES, "after a community change");
      await openFamilyWithPanel();
      expectNoValues(VALUES, "after a community change and reopening");
      expect(showButton()).toBeTruthy();
      expect(callsTo(second.calls, READ_CONTACTS)).toHaveLength(1);
    });

    it("the contacts are dropped when the family answers not found", async () => {
      let reads = 0;
      const { calls } = await openScreen({
        rename: () => json(409, {}),
        detail: (body) => {
          reads += 1;
          return reads === 2 ? empty(404) : json(200, detailBody(body.householdId, 3));
        },
      });
      await openFamilyWithPanel();
      await showLoaded();
      await screen.findByText(MAYA.name);

      async function refusedRenameThenReload() {
        const before = callsTo(calls, READ).length;
        fireEvent.click(screen.getByRole("button", { name: "Rename household" }));
        fireEvent.click(await screen.findByRole("button", { name: "Save changes" }));
        fireEvent.click(await screen.findByRole("button", { name: "Reload" }));
        await waitFor(() => expect(callsTo(calls, READ)).toHaveLength(before + 1));
      }

      // The reload answers not found: the panel is gone and nothing of the contacts is on screen.
      await refusedRenameThenReload();
      await screen.findByText("Household not found");
      expect(screen.queryByRole("heading", { name: "Emergency contacts" })).toBeNull();
      expectNoValues(VALUES, "after not found");

      // The family is readable again: the panel comes back closed, not with the old contacts.
      await refusedRenameThenReload();
      await screen.findByRole("heading", { name: "Emergency contacts" });
      await flushPending();
      expect(showButton()).toBeTruthy();
      expectNoValues(VALUES, "after the family is back");
    });

    it("opening another family drops the contacts", async () => {
      const { calls } = await withTypedRow();
      fireEvent.click(screen.getByRole("button", { name: "Back to list" }));
      await openFamilyWithPanel("Webb Family");
      expectNoValues(VALUES, "after opening another family");
      expect(showButton()).toBeTruthy();
      expect(callsTo(calls, READ_CONTACTS)).toHaveLength(1);
    });

    it("leaving the screen drops the contacts, and a late answer shows nothing", async () => {
      const read = deferred();
      const { calls } = await openScreen({ read: () => read.promise });
      await openFamilyWithPanel();
      fireEvent.click(showButton());
      await waitFor(() => expect(callsTo(calls, READ_CONTACTS)).toHaveLength(1));
      await act(async () => {
        await router.navigate("/contacts");
      });
      await screen.findByRole("heading", { name: "All Contacts" });
      await act(async () => {
        read.release(json(200, { householdId: ID_A, version: 3, contacts: [MAYA, OWEN] }));
      });
      await flushPending();
      expectNoValues(VALUES, "after leaving the screen");

      await act(async () => {
        await router.navigate("/family-records");
      });
      await openFamilyWithPanel();
      expect(showButton()).toBeTruthy();
      expectNoValues(VALUES, "after coming back");
    });

    describe("losing people.restricted.read", () => {
      const full: PeopleAccess = {
        permissions: {
          "people.view": true,
          "people.manage": true,
          "people.restricted.read": true,
          "people.delete": true,
          "service_times.manage": false,
        },
        entitlements: {
          "people.directory": true,
          "people.households": true,
          "module.engagement": false,
        },
        roles: { communityAdmin: true },
      };
      const lost: PeopleAccess = {
        ...full,
        permissions: { ...full.permissions, "people.restricted.read": false },
      };

      function page(access: PeopleAccess) {
        return (
          <PeopleAccessContext.Provider value={{ access }}>
            <CommunityProvider>
              <BillingStatusProvider>
                <MemoryRouter initialEntries={["/family-records"]}>
                  <FamilyRecordsPage />
                </MemoryRouter>
              </BillingStatusProvider>
            </CommunityProvider>
          </PeopleAccessContext.Provider>
        );
      }

      it("drops the contacts and the typed rows, and a late save answer shows nothing", async () => {
        sessionStorage.setItem("community-hub.access-token", TOKEN);
        sessionStorage.setItem("community-hub.community", SLUG);
        const answer = deferred();
        const { calls } = mockServer({ save: () => answer.promise });
        const view = render(page(full));
        await openFamilyWithPanel();
        await showLoaded();
        startEdit();
        type("Contact 1 name", TYPED_NAME);
        save();
        await waitFor(() => expect(callsTo(calls, SAVE_CONTACTS)).toHaveLength(1));

        view.rerender(page(lost));
        await flushPending();
        expect(screen.queryByRole("heading", { name: "Emergency contacts" })).toBeNull();
        expectNoValues(VALUES, "after losing the permission");

        await act(async () => {
          answer.release(json(200, { householdId: ID_A, version: 4 }));
        });
        await flushPending();
        expectNoValues(VALUES, "after a late save answer");

        view.rerender(page(full));
        await screen.findByRole("heading", { name: "Emergency contacts" });
        expect(showButton()).toBeTruthy();
        expectNoValues(VALUES, "after getting it back");
        expect(callsTo(calls, READ_CONTACTS)).toHaveLength(1);
      });
    });

    it("nothing goes to a URL, title, storage, log or data attribute", async () => {
      const setItem = vi.spyOn(Storage.prototype, "setItem");
      const logs = (["log", "info", "warn", "error", "debug"] as const).map((method) =>
        vi.spyOn(console, method).mockImplementation(() => {}),
      );
      const { calls } = await openScreen();
      await openFamilyWithPanel();
      await showLoaded();
      startEdit();
      type("Contact 1 name", TYPED_NAME);
      type("Contact 1 phone", TYPED_PHONE);
      save();
      await screen.findByText(TYPED_NAME);

      for (const value of VALUES) {
        expect(document.title.includes(value), `title ${value}`).toBe(false);
        expect(window.location.href.includes(value), `location ${value}`).toBe(false);
        for (const call of calls) {
          expect(call.url.includes(value), `url ${value}`).toBe(false);
        }
        for (const [key, stored] of setItem.mock.calls) {
          expect(`${key}=${stored}`.includes(value), `storage ${value}`).toBe(false);
        }
        for (const spy of logs) {
          expect(JSON.stringify(spy.mock.calls).includes(value), `log ${value}`).toBe(false);
        }
        for (const element of Array.from(document.querySelectorAll("*"))) {
          for (const attribute of Array.from(element.attributes)) {
            if (attribute.name.startsWith("data-") || attribute.name === "title") {
              expect(attribute.value.includes(value), `${attribute.name} ${value}`).toBe(false);
            }
          }
        }
      }
      for (const key of Object.keys(sessionStorage)) {
        expect(VALUES.some((value) => (sessionStorage.getItem(key) ?? "").includes(value))).toBe(
          false,
        );
      }
    });
  });

  describe("late answers and reloads", () => {
    it("a late emergency contacts answer after a community change is ignored", async () => {
      const answer = deferred();
      const { calls } = await openScreen({ read: () => answer.promise });
      await openFamilyWithPanel();
      fireEvent.click(showButton());
      await waitFor(() => expect(callsTo(calls, READ_CONTACTS)).toHaveLength(1));
      await switchCommunity();
      await openFamilyWithPanel();
      await act(async () => {
        answer.release(json(200, { householdId: ID_A, version: 3, contacts: [MAYA, OWEN] }));
      });
      await flushPending();
      expectNoValues(VALUES, "after a late read");
      expect(showButton()).toBeTruthy();
      expect(screen.queryByText("Loading emergency contacts...")).toBeNull();
      expect(callsTo(calls, READ_CONTACTS)).toHaveLength(1);
    });

    it("a late emergency contacts save after a community change is ignored", async () => {
      const answer = deferred();
      const { calls } = await openScreen({ save: () => answer.promise });
      await openFamilyWithPanel();
      await showLoaded();
      startEdit();
      type("Contact 1 name", TYPED_NAME);
      save();
      await waitFor(() => expect(callsTo(calls, SAVE_CONTACTS)).toHaveLength(1));
      await switchCommunity();
      await openFamilyWithPanel();
      await act(async () => {
        answer.release(json(200, { householdId: ID_A, version: 9 }));
      });
      await flushPending();
      expectNoValues(VALUES, "after a late save");
      expect(showButton()).toBeTruthy();

      // The other community's family still has its own version.
      fireEvent.click(screen.getByRole("button", { name: "Rename household" }));
      fireEvent.change(await screen.findByRole("textbox", { name: "Household name" }), {
        target: { value: "Quill Family" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
      await waitFor(() => expect(callsTo(calls, RENAME)).toHaveLength(1));
      expect(callsTo(calls, RENAME)[0]!.body).toMatchObject({
        communitySlug: OTHER_SLUG,
        version: 3,
      });
      await screen.findByText("Quill Family");
    });

    it("a detail reload of the same family keeps the typed rows and the answer of an open read", async () => {
      const answer = deferred();
      let reads = 0;
      const { calls } = await openScreen({
        read: (body) => {
          reads += 1;
          return reads === 1
            ? answer.promise
            : json(200, { householdId: body.householdId, version: 3, contacts: [MAYA] });
        },
      });
      await openFamilyWithPanel();
      fireEvent.click(showButton());
      await waitFor(() => expect(callsTo(calls, READ_CONTACTS)).toHaveLength(1));
      await renameFamily("Quill Family");
      await act(async () => {
        answer.release(json(200, { householdId: ID_A, version: 3, contacts: [MAYA, OWEN] }));
      });
      await screen.findByText(OWEN.name);
      expect(callsTo(calls, READ_CONTACTS)).toHaveLength(1);
    });

    it("a detail reload of the same family keeps the typed rows and the answer of an open save", async () => {
      const answer = deferred();
      const { calls } = await openScreen({ save: () => answer.promise });
      await openFamilyWithPanel();
      await showLoaded();
      startEdit();
      type("Contact 1 name", TYPED_NAME);
      save();
      await waitFor(() => expect(callsTo(calls, SAVE_CONTACTS)).toHaveLength(1));
      await renameFamily("Quill Family");
      await act(async () => {
        answer.release(json(200, { householdId: ID_A, version: 9 }));
      });
      await screen.findByText(TYPED_NAME);
      expect(screen.getByRole("button", { name: "Edit emergency contacts" })).toBeTruthy();
      // The saved version is now the family's version.
      fireEvent.click(screen.getByRole("button", { name: "Rename household" }));
      fireEvent.click(await screen.findByRole("button", { name: "Save changes" }));
      await waitFor(() => expect(callsTo(calls, RENAME)).toHaveLength(2));
      expect(callsTo(calls, RENAME)[1]!.body.version).toBe(9);
    });

    it("typed rows survive a rename of the same family", async () => {
      await openScreen();
      await openFamilyWithPanel();
      await showLoaded();
      startEdit();
      type("Contact 1 name", TYPED_NAME);
      await renameFamily("Quill Family");
      expect(field("Contact 1 name").value).toBe(TYPED_NAME);
      expect(screen.getByRole("button", { name: "Save emergency contacts" })).toBeTruthy();
    });
  });

  describe("accessibility", () => {
    async function allStates(label: string, width: number) {
      setViewportWidth(width);

      const hidden = await openScreen();
      await openFamilyWithPanel();
      await expectNoViolations(hidden.container, `${label} hidden`);
      await showLoaded();
      await expectNoViolations(hidden.container, `${label} list`);
      startEdit();
      await expectNoViolations(hidden.container, `${label} edit`);
      type("Contact 1 name", "");
      save();
      await screen.findByText("Enter a name.");
      await expectNoViolations(hidden.container, `${label} field errors`);
      await resetScreen();

      const empty0 = await openScreen({ contacts: [] });
      await openFamilyWithPanel();
      await showLoaded();
      await expectNoViolations(empty0.container, `${label} empty`);
      startEdit();
      for (let number = 1; number <= MAX_EMERGENCY_CONTACTS; number += 1) {
        fireEvent.click(screen.getByRole("button", { name: "Add contact" }));
      }
      await expectNoViolations(empty0.container, `${label} edit with five rows`);
      await resetScreen();

      const conflict = await openScreen({ save: () => json(409, {}) });
      await openFamilyWithPanel();
      await showLoaded();
      startEdit();
      save();
      await screen.findByText(MSG_CONFLICT);
      await expectNoViolations(conflict.container, `${label} conflict alert`);
      await resetScreen();

      const readOnly = await openScreen({ billing: "read_only" });
      await openFamilyWithPanel();
      await showLoaded();
      await expectNoViolations(readOnly.container, `${label} read-only`);
      await resetScreen();

      const failed = await openScreen({ read: () => empty(500) });
      await openFamilyWithPanel();
      fireEvent.click(showButton());
      await screen.findByText(MSG_LOAD_FAILED);
      await expectNoViolations(failed.container, `${label} load failure`);
      await resetScreen();
    }

    it("has no axe violations in any state at 1280 px", async () => {
      await allStates("1280", 1280);
    }, 60000);

    it("has no axe violations in any state at 375 px", async () => {
      await allStates("375", 375);
    }, 60000);
  });
});
