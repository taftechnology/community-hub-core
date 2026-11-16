import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import axe from "axe-core";
import { StrictMode } from "react";
import { afterEach, beforeEach } from "vitest";

import { router, Shell } from "./shell";

const TOKEN = "token-1";
const GUEST = "guest@example.test";
const PARISH_EMAIL = "parish.guest@example.test";
const CATHEDRAL_EMAIL = "cathedral.guest@example.test";
const STALE_EMAIL = "stale.guest@example.test";
const INVITE_ID = "00000000-0000-4000-8000-0000000000c1";
const PERSON_ID = "00000000-0000-4000-8000-0000000000d1";
const CUSTOM_ROLE_ID = "00000000-0000-4000-8000-0000000000e1";
const USER_ID = "00000000-0000-4000-8000-0000000000a1";

const SENTENCE = {
  email: "Enter a valid email address.",
  permission: "You don't have permission to do that.",
  already: "This address already has a pending invitation.",
  tooManyCreate: "Too many invitations for now. Try again later.",
  tooManyResend: "This invitation has been resent too often. Try again tomorrow.",
  linked: "That contact is already linked to a user.",
  minor: "That contact is under 18 and can't be linked to a user.",
  personMissing: "That contact can't be found.",
  roleMissing: "That role no longer exists.",
  invitationMissing: "This invitation is no longer pending.",
  readOnly: "Your organisation is read-only. Update billing to make changes.",
  unavailable: "Invitations are not available yet.",
  generic: "Something went wrong. Try again.",
  choose: "Choose a role or a contact",
};

const FULL = [
  "access.users.manage",
  "access.users.view",
  "access.roles.manage",
  "access.roles.view",
  "people.view",
];

type Phase = "post" | "json" | "catch";

type Hold = {
  take: () => Response | Promise<Response>;
  finish: () => Promise<void>;
  ready: Promise<void>;
  jsonSpy?: ReturnType<typeof vi.spyOn>;
};

function resultIds(
  results: axe.AxeResults,
  bucket: "passes" | "violations" | "incomplete" | "inapplicable",
): string[] {
  return results[bucket].map((entry) => entry.id);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function billingResponse(state: string): Response {
  return jsonResponse({
    state,
    canView: true,
    canManage: true,
    trial_end: null,
    grace_until: null,
  });
}

function directory(permissions: string[]) {
  return {
    grants: [] as unknown[],
    customRoles: [
      {
        customRoleId: CUSTOM_ROLE_ID,
        key: "welcomer",
        permissions: ["access.users.view"],
      },
    ],
    catalogue: ["access.users.view"],
    builtIn: [
      {
        roleKey: "staff",
        scope: "community",
        permissions: ["access.users.view"],
      },
      {
        roleKey: "org_owner",
        scope: "organisation",
        permissions: ["access.users.view"],
      },
    ],
    userLinks: [] as unknown[],
    permissions,
  };
}

function invitation(
  email: string | null,
  roleKey: string | null = "staff",
  customRoleId: string | null = null,
  linksContact = true,
) {
  return {
    id: INVITE_ID,
    email,
    roleKey,
    customRoleId,
    linksContact,
    expiresAt: "2026-12-01T00:00:00.000Z",
  };
}

function person(given: string, family: string, id = PERSON_ID, isMinor = false) {
  return {
    id,
    personId: id,
    givenName: given,
    familyName: family,
    isMinor,
  };
}

const defaultUsers = [
  {
    userId: USER_ID,
    personId: null,
    name: { given: "Morgan", family: "Finch" },
    email: "morgan.finch@example.test",
    phone: null,
    minor: false,
  },
];

function parseBody(init?: RequestInit): Record<string, unknown> {
  if (typeof init?.body !== "string") {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(init.body);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return {};
  }
  return {};
}

function createHold(phase: Phase, status: number, payload: unknown): Hold {
  let readyResolve!: () => void;
  const ready = new Promise<void>((resolve) => {
    readyResolve = resolve;
  });

  if (phase === "post") {
    const pending = deferred<Response>();
    const response =
      status === 204
        ? new Response(null, { status: 204 })
        : new Response(JSON.stringify(payload), {
            status,
            headers: { "content-type": "application/json" },
          });
    const jsonSpy = vi.spyOn(response, "json");
    return {
      ready,
      jsonSpy,
      take: () => {
        readyResolve();
        return pending.promise;
      },
      finish: async () => {
        await act(async () => {
          pending.resolve(response);
          for (let step = 0; step < 20; step += 1) {
            await Promise.resolve();
          }
        });
      },
    };
  }

  const pending = deferred<unknown>();
  const response = {
    status,
    headers: new Headers({ "content-type": "application/json" }),
    json: () => {
      readyResolve();
      return pending.promise;
    },
  } as unknown as Response;

  return {
    ready,
    take: () => response,
    finish: async () => {
      if (phase === "json") {
        pending.resolve(payload);
        await pending.promise;
      } else {
        pending.reject(new Error("rejected json"));
        try {
          await pending.promise;
        } catch {
          // The catch-phase promise rejects on purpose.
        }
      }
      await act(async () => {});
    },
  };
}

function installFetch(holdUrl: string, hold: Hold, invitationsFor: (slug: string) => unknown[]) {
  let used = false;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    const body = parseBody(init);
    const slug = typeof body.communitySlug === "string" ? body.communitySlug : "";
    if (url.includes(holdUrl) && slug === "parish" && !used) {
      used = true;
      return hold.take();
    }
    if (url.includes("/v1/billing/status")) {
      return billingResponse("ok");
    }
    if (url.includes("/v1/access/grants/list")) {
      return jsonResponse(directory(FULL));
    }
    if (url.includes("/v1/access/users/list")) {
      return jsonResponse({ phoneVisible: false, users: defaultUsers });
    }
    if (url.includes("/v1/access/invitations/list")) {
      return jsonResponse({ invitations: invitationsFor(slug) });
    }
    if (url.includes("/v1/people/list")) {
      const family = slug === "cathedral" ? "Cathedral" : "Parish";
      return jsonResponse({ items: [person("Nia", family)], nextCursor: null });
    }
    return new Response(null, { status: 404 });
  });
}

function rowsFor(slug: string): unknown[] {
  return [invitation(slug === "cathedral" ? CATHEDRAL_EMAIL : PARISH_EMAIL)];
}

async function runStale(options: {
  phase: Phase;
  holdUrl: string;
  status: number;
  payload: unknown;
  staleText: string;
  errorText?: string;
  arm: () => Promise<void>;
}) {
  const hold = createHold(options.phase, options.status, options.payload);
  installFetch(options.holdUrl, hold, rowsFor);
  await mount();
  await options.arm();
  await hold.ready;
  setCommunity("cathedral");
  expect(await screen.findByText(CATHEDRAL_EMAIL)).toBeTruthy();
  await act(async () => {});
  expect(await screen.findByText(CATHEDRAL_EMAIL)).toBeTruthy();
  await hold.finish();
  expect(screen.queryByText(options.staleText)).toBeNull();
  expect(screen.getByText(CATHEDRAL_EMAIL)).toBeTruthy();
  if (options.phase === "post") {
    if (hold.jsonSpy === undefined) {
      throw new Error("missing json spy");
    }
    expect(hold.jsonSpy).not.toHaveBeenCalled();
  }
  if (options.errorText !== undefined) {
    expect(screen.queryByText(options.errorText)).toBeNull();
  }
}

function start(options: {
  permissions: string[];
  invitations?: (slug: string) => unknown[];
  users?: unknown[];
  billingState?: string;
  on?: (url: string, body: Record<string, unknown>) => Response | Promise<Response> | undefined;
}) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    const body = parseBody(init);
    calls.push({ url, body });
    const custom = options.on?.(url, body);
    if (custom !== undefined) {
      return custom;
    }
    if (url.includes("/v1/billing/status")) {
      return billingResponse(options.billingState ?? "ok");
    }
    if (url.includes("/v1/access/grants/list")) {
      return jsonResponse(directory(options.permissions));
    }
    if (url.includes("/v1/access/users/list")) {
      return jsonResponse({ phoneVisible: false, users: options.users ?? defaultUsers });
    }
    if (url.includes("/v1/access/invitations/list")) {
      const slug = typeof body.communitySlug === "string" ? body.communitySlug : "";
      return jsonResponse({ invitations: options.invitations?.(slug) ?? [] });
    }
    if (url.includes("/v1/people/list")) {
      return jsonResponse({ items: [], nextCursor: null });
    }
    return new Response(null, { status: 404 });
  });
  return { calls };
}

function setCommunity(slug: string) {
  fireEvent.change(screen.getByRole("textbox", { name: "Community" }), {
    target: { value: slug },
  });
  fireEvent.click(screen.getByRole("button", { name: "Set" }));
}

async function mount(strict = false) {
  sessionStorage.setItem("community-hub.access-token", TOKEN);
  await router.navigate("/settings/users");
  if (strict) {
    render(
      <StrictMode>
        <Shell />
      </StrictMode>,
    );
  } else {
    render(<Shell />);
  }
  setCommunity("parish");
}

function invitePanel(): HTMLElement {
  const panel = screen.getByRole("heading", { name: "Invite user" }).closest("section");
  if (panel === null) {
    throw new Error("invite panel missing");
  }
  return panel;
}

function pendingPanel(): HTMLElement {
  const panel = screen.getByRole("heading", { name: "Pending invitations" }).closest("section");
  if (panel === null) {
    throw new Error("pending panel missing");
  }
  return panel;
}

async function fillInvite(email: string, roleValue?: string) {
  fireEvent.change(await screen.findByRole("textbox", { name: "Email" }), {
    target: { value: email },
  });
  if (roleValue !== undefined) {
    fireEvent.change(screen.getByRole("combobox", { name: "Role" }), {
      target: { value: roleValue },
    });
  }
}

async function armInvite() {
  await screen.findByText(PARISH_EMAIL);
  await fillInvite(GUEST, "role:staff");
  const form = screen.getByRole("button", { name: "Send invitation" }).closest("form");
  if (form === null) {
    throw new Error("invite form missing");
  }
  fireEvent.submit(form);
}

async function armResend() {
  fireEvent.click(await screen.findByRole("button", { name: "Resend" }));
}

async function armRevoke() {
  fireEvent.click(await screen.findByRole("button", { name: "Revoke" }));
}

async function armPeople() {
  await screen.findByRole("heading", { name: "Invite user" });
  const panel = invitePanel();
  fireEvent.change(within(panel).getByRole("textbox", { name: "Contact" }), {
    target: { value: "Nia" },
  });
  fireEvent.click(within(panel).getByRole("button", { name: "Search" }));
}

beforeEach(async () => {
  sessionStorage.clear();
  await router.navigate("/");
});

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.restoreAllMocks();
});

it("pin 45 invite: stale response after post never calls json()", async () => {
  await runStale({
    phase: "post",
    holdUrl: "/v1/access/invitations/create",
    status: 201,
    payload: { invitationId: INVITE_ID },
    staleText: `Invitation sent to ${GUEST}`,
    arm: armInvite,
  });
});

it("pin 45 invite: stale response after json() never updates the screen", async () => {
  await runStale({
    phase: "json",
    holdUrl: "/v1/access/invitations/create",
    status: 201,
    payload: { invitationId: INVITE_ID },
    staleText: `Invitation sent to ${GUEST}`,
    arm: armInvite,
  });
});

it("pin 45 invite: stale response whose json() rejects leaves no error", async () => {
  await runStale({
    phase: "catch",
    holdUrl: "/v1/access/invitations/create",
    status: 400,
    payload: {},
    staleText: SENTENCE.email,
    errorText: SENTENCE.email,
    arm: armInvite,
  });
});

it("pin 45 list: stale response after post never calls json()", async () => {
  await runStale({
    phase: "post",
    holdUrl: "/v1/access/invitations/list",
    status: 200,
    payload: { invitations: [invitation(STALE_EMAIL)] },
    staleText: STALE_EMAIL,
    arm: async () => {},
  });
});

it("pin 45 list: stale response after json() never updates the screen", async () => {
  await runStale({
    phase: "json",
    holdUrl: "/v1/access/invitations/list",
    status: 200,
    payload: { invitations: [invitation(STALE_EMAIL)] },
    staleText: STALE_EMAIL,
    arm: async () => {},
  });
});

it("pin 45 list: stale response whose json() rejects leaves no error", async () => {
  await runStale({
    phase: "catch",
    holdUrl: "/v1/access/invitations/list",
    status: 503,
    payload: {},
    staleText: SENTENCE.unavailable,
    errorText: SENTENCE.unavailable,
    arm: async () => {},
  });
});

it("pin 45 resend: stale response after post never calls json()", async () => {
  await runStale({
    phase: "post",
    holdUrl: "/v1/access/invitations/resend",
    status: 204,
    payload: {},
    staleText: PARISH_EMAIL,
    arm: armResend,
  });
});

it("pin 45 resend: stale response after json() never updates the screen", async () => {
  await runStale({
    phase: "json",
    holdUrl: "/v1/access/invitations/resend",
    status: 204,
    payload: {},
    staleText: PARISH_EMAIL,
    arm: armResend,
  });
});

it("pin 45 resend: stale response whose json() rejects leaves no error", async () => {
  await runStale({
    phase: "catch",
    holdUrl: "/v1/access/invitations/resend",
    status: 403,
    payload: {},
    staleText: SENTENCE.permission,
    errorText: SENTENCE.permission,
    arm: armResend,
  });
});

it("pin 45 revoke: stale response after post never calls json()", async () => {
  await runStale({
    phase: "post",
    holdUrl: "/v1/access/invitations/revoke",
    status: 204,
    payload: {},
    staleText: PARISH_EMAIL,
    arm: armRevoke,
  });
});

it("pin 45 revoke: stale response after json() never updates the screen", async () => {
  await runStale({
    phase: "json",
    holdUrl: "/v1/access/invitations/revoke",
    status: 204,
    payload: {},
    staleText: PARISH_EMAIL,
    arm: armRevoke,
  });
});

it("pin 45 revoke: stale response whose json() rejects leaves no error", async () => {
  await runStale({
    phase: "catch",
    holdUrl: "/v1/access/invitations/revoke",
    status: 402,
    payload: {},
    staleText: SENTENCE.readOnly,
    errorText: SENTENCE.readOnly,
    arm: armRevoke,
  });
});

it("pin 45 people: stale response after post never calls json()", async () => {
  await runStale({
    phase: "post",
    holdUrl: "/v1/people/list",
    status: 200,
    payload: { items: [person("Nia", "Stale")], nextCursor: null },
    staleText: "Nia Stale",
    arm: armPeople,
  });
});

it("pin 45 people: stale response after json() never updates the screen", async () => {
  await runStale({
    phase: "json",
    holdUrl: "/v1/people/list",
    status: 200,
    payload: { items: [person("Nia", "Stale")], nextCursor: null },
    staleText: "Nia Stale",
    arm: armPeople,
  });
});

it("pin 45 people: stale response whose json() rejects leaves no error", async () => {
  await runStale({
    phase: "catch",
    holdUrl: "/v1/people/list",
    status: 500,
    payload: {},
    staleText: SENTENCE.generic,
    errorText: SENTENCE.generic,
    arm: armPeople,
  });
});

it("shows the invite form with access.users.manage", async () => {
  start({ permissions: ["access.users.manage"] });
  await mount();
  expect(await screen.findByRole("heading", { name: "Invite user" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Send invitation" })).toBeTruthy();
});

it("hides the invite form without access.users.manage", async () => {
  start({
    permissions: ["access.users.view", "access.roles.view", "access.roles.manage"],
  });
  await mount();
  expect(await screen.findByRole("button", { name: "Grant" })).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "Invite user" })).toBeNull();
});

it("shows the role select with access.roles.manage", async () => {
  start({ permissions: ["access.users.manage", "access.roles.manage"] });
  await mount();
  expect(await screen.findByRole("combobox", { name: "Role" })).toBeTruthy();
});

it("hides the role select without access.roles.manage", async () => {
  start({ permissions: ["access.users.manage"] });
  await mount();
  expect(await screen.findByRole("button", { name: "Send invitation" })).toBeTruthy();
  expect(screen.queryByRole("combobox", { name: "Role" })).toBeNull();
});

it("shows the contact picker with people.view", async () => {
  start({ permissions: ["access.users.manage", "people.view"] });
  await mount();
  await screen.findByRole("heading", { name: "Invite user" });
  expect(within(invitePanel()).getByRole("textbox", { name: "Contact" })).toBeTruthy();
  expect(within(invitePanel()).getByRole("button", { name: "Search" })).toBeTruthy();
});

it("hides the contact picker without people.view", async () => {
  start({ permissions: ["access.users.manage"] });
  await mount();
  expect(await screen.findByRole("button", { name: "Send invitation" })).toBeTruthy();
  expect(within(invitePanel()).queryByRole("textbox", { name: "Contact" })).toBeNull();
});

it("shows the pending panel with access.users.view and access.roles.view", async () => {
  start({
    permissions: ["access.users.view", "access.roles.view"],
    invitations: () => [invitation(PARISH_EMAIL)],
  });
  await mount();
  expect(await screen.findByRole("heading", { name: "Pending invitations" })).toBeTruthy();
  expect(await screen.findByText(PARISH_EMAIL)).toBeTruthy();
});

it("hides the pending panel without access.roles.view", async () => {
  start({
    permissions: ["access.users.view", "access.users.manage"],
    invitations: () => [invitation(PARISH_EMAIL)],
  });
  await mount();
  expect(await screen.findByRole("button", { name: "Send invitation" })).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "Pending invitations" })).toBeNull();
});

it("hides the pending panel without access.users.view", async () => {
  start({ permissions: ["access.roles.view", "access.roles.manage"] });
  await mount();
  expect(await screen.findByRole("button", { name: "Grant" })).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "Pending invitations" })).toBeNull();
});

it("shows Resend and Revoke with access.users.manage", async () => {
  start({
    permissions: ["access.users.manage", "access.users.view", "access.roles.view"],
    invitations: () => [invitation(PARISH_EMAIL)],
  });
  await mount();
  expect(await screen.findByRole("button", { name: "Resend" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Revoke" })).toBeTruthy();
});

it("hides Resend and Revoke without access.users.manage", async () => {
  start({
    permissions: ["access.users.view", "access.roles.view"],
    invitations: () => [invitation(PARISH_EMAIL)],
  });
  await mount();
  expect(await screen.findByText(PARISH_EMAIL)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Resend" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Revoke" })).toBeNull();
});

it("hides Resend and Revoke when billing is read-only and still lists pending invitations", async () => {
  start({
    permissions: FULL,
    billingState: "read_only",
    invitations: () => [invitation("pending.guest@example.test")],
  });
  await mount();
  expect(await screen.findByText("pending.guest@example.test")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Resend" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Revoke" })).toBeNull();
  expect(screen.queryByRole("heading", { name: "Invite user" })).toBeNull();
});

it("shows the invitation email, role label, contact link and expiry", async () => {
  start({
    permissions: ["access.users.view", "access.roles.view"],
    invitations: () => [invitation(PARISH_EMAIL)],
  });
  await mount();
  expect(await screen.findByRole("heading", { name: "Pending invitations" })).toBeTruthy();
  const panel = pendingPanel();
  expect(await within(panel).findByText(PARISH_EMAIL)).toBeTruthy();
  expect(within(panel).getByText("Staff")).toBeTruthy();
  expect(within(panel).getByText("Links a contact")).toBeTruthy();
  expect(
    within(panel).getByText(new Date("2026-12-01T00:00:00.000Z").toLocaleDateString()),
  ).toBeTruthy();
  expect(panel.textContent).not.toContain(INVITE_ID);
});

it("shows Address removed when the invitation email is null", async () => {
  start({
    permissions: ["access.users.view", "access.roles.view"],
    invitations: () => [invitation(null)],
  });
  await mount();
  expect(await screen.findByRole("heading", { name: "Pending invitations" })).toBeTruthy();
  const panel = pendingPanel();
  expect(await within(panel).findByText("Staff")).toBeTruthy();
  expect(within(panel).getByText("Address removed")).toBeTruthy();
  expect(panel.textContent).not.toContain(INVITE_ID);
});

it("shows a custom role's label and not its id", async () => {
  start({
    permissions: ["access.users.view", "access.roles.view"],
    invitations: () => [invitation("role.guest@example.test", null, CUSTOM_ROLE_ID, false)],
  });
  await mount();
  expect(await screen.findByRole("heading", { name: "Pending invitations" })).toBeTruthy();
  const panel = pendingPanel();
  expect(await within(panel).findByText("welcomer")).toBeTruthy();
  expect(panel.textContent).not.toContain(CUSTOM_ROLE_ID);
  expect(within(panel).queryByText("Links a contact")).toBeNull();
});

it("shows Choose a role or a contact and sends nothing", async () => {
  const { calls } = start({ permissions: FULL });
  await mount();
  await fillInvite(GUEST);
  fireEvent.click(screen.getByRole("button", { name: "Send invitation" }));
  expect(within(invitePanel()).getByRole("alert").textContent).toBe(SENTENCE.choose);
  expect(calls.some((call) => call.url.includes("/v1/access/invitations/create"))).toBe(false);
});

it("shows Enter a valid email address when the invite email is empty and sends nothing", async () => {
  const { calls } = start({ permissions: FULL });
  await mount();
  await fillInvite("   ", "role:staff");
  fireEvent.click(screen.getByRole("button", { name: "Send invitation" }));
  expect(within(invitePanel()).getByRole("alert").textContent).toBe(SENTENCE.email);
  expect(calls.some((call) => call.url.includes("/v1/access/invitations/create"))).toBe(false);
});

const createErrors: { title: string; status: number; code?: string; sentence: string }[] = [
  {
    title: "shows Enter a valid email address when create answers 400",
    status: 400,
    sentence: SENTENCE.email,
  },
  {
    title: "shows the permission sentence when create answers 403",
    status: 403,
    sentence: SENTENCE.permission,
  },
  {
    title: "shows the already-invited sentence when create answers 409 already_invited",
    status: 409,
    code: "already_invited",
    sentence: SENTENCE.already,
  },
  {
    title: "shows the create limit sentence when create answers 409 too_many",
    status: 409,
    code: "too_many",
    sentence: SENTENCE.tooManyCreate,
  },
  {
    title: "shows the linked sentence when create answers 409 person_linked",
    status: 409,
    code: "person_linked",
    sentence: SENTENCE.linked,
  },
  {
    title: "shows the minor sentence when create answers 422 person_minor",
    status: 422,
    code: "person_minor",
    sentence: SENTENCE.minor,
  },
  {
    title: "shows the missing contact sentence when create answers 404 person_not_found",
    status: 404,
    code: "person_not_found",
    sentence: SENTENCE.personMissing,
  },
  {
    title: "shows the missing role sentence when create answers 404 role_not_found",
    status: 404,
    code: "role_not_found",
    sentence: SENTENCE.roleMissing,
  },
  {
    title: "shows the read-only sentence when create answers 402",
    status: 402,
    sentence: SENTENCE.readOnly,
  },
  {
    title: "shows the unavailable sentence when create answers 503",
    status: 503,
    sentence: SENTENCE.unavailable,
  },
  {
    title: "shows the generic sentence when create answers 500",
    status: 500,
    sentence: SENTENCE.generic,
  },
];

for (const row of createErrors) {
  it(row.title, async () => {
    start({
      permissions: FULL,
      on: (url) => {
        if (!url.includes("/v1/access/invitations/create")) {
          return undefined;
        }
        if (row.code === undefined) {
          return new Response(null, { status: row.status });
        }
        return jsonResponse({ error: row.code }, row.status);
      },
    });
    await mount();
    await fillInvite("not-an-email", "role:staff");
    fireEvent.click(screen.getByRole("button", { name: "Send invitation" }));
    const alert = await within(invitePanel()).findByRole("alert");
    expect(alert.textContent).toBe(row.sentence);
    expect(alert.textContent ?? "").not.toContain("not-an-email");
    if (row.code !== undefined) {
      expect(alert.textContent ?? "").not.toContain(row.code);
    }
    const email = within(invitePanel()).getByRole("textbox", { name: "Email" }) as HTMLInputElement;
    expect(email.value).toBe("not-an-email");
  });
}

it("shows the resend limit sentence when resend answers 409 too_many", async () => {
  start({
    permissions: ["access.users.manage", "access.users.view", "access.roles.view"],
    invitations: () => [invitation("pending.guest@example.test")],
    on: (url) => {
      if (url.includes("/v1/access/invitations/resend")) {
        return jsonResponse({ error: "too_many" }, 409);
      }
      return undefined;
    },
  });
  await mount();
  fireEvent.click(await screen.findByRole("button", { name: "Resend" }));
  const alert = await within(pendingPanel()).findByRole("alert");
  expect(alert.textContent).toBe(SENTENCE.tooManyResend);
  expect(alert.textContent ?? "").not.toContain("pending.guest@example.test");
  expect(alert.textContent ?? "").not.toContain("too_many");
});

it("shows the pending sentence when revoke answers 404 invitation_not_found", async () => {
  start({
    permissions: ["access.users.manage", "access.users.view", "access.roles.view"],
    invitations: () => [invitation("pending.guest@example.test")],
    on: (url) => {
      if (url.includes("/v1/access/invitations/revoke")) {
        return jsonResponse({ error: "invitation_not_found" }, 404);
      }
      return undefined;
    },
  });
  await mount();
  fireEvent.click(await screen.findByRole("button", { name: "Revoke" }));
  const alert = await within(pendingPanel()).findByRole("alert");
  expect(alert.textContent).toBe(SENTENCE.invitationMissing);
  expect(alert.textContent ?? "").not.toContain("pending.guest@example.test");
  expect(alert.textContent ?? "").not.toContain("invitation_not_found");
});

it("submits the typed email when the form appears with the list reset still pending", async () => {
  let releaseBilling!: (value: Response) => void;
  const billingHeld = new Promise<Response>((resolve) => {
    releaseBilling = resolve;
  });
  let releaseGrants!: (value: Response) => void;
  const grantsHeld = new Promise<Response>((resolve) => {
    releaseGrants = resolve;
  });
  const { calls } = start({
    permissions: FULL,
    on: (url) => {
      if (url.includes("/v1/billing/status")) {
        return billingHeld;
      }
      if (url.includes("/v1/access/grants/list")) {
        return grantsHeld;
      }
      if (url.includes("/v1/access/invitations/create")) {
        return jsonResponse({ invitationId: INVITE_ID }, 201);
      }
      return undefined;
    },
  });
  await mount();
  await act(async () => {
    releaseBilling(billingResponse("ok"));
  });
  expect(screen.queryByRole("textbox", { name: "Email" })).toBeNull();

  const actGlobal = globalThis as unknown as {
    IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
  };
  const previousAct = actGlobal.IS_REACT_ACT_ENVIRONMENT;
  actGlobal.IS_REACT_ACT_ENVIRONMENT = false;
  try {
    releaseGrants(jsonResponse(directory(FULL)));
    // Stop on the turn the form appears. The next turn would be the list effect.
    for (let i = 0; i < 20 && screen.queryByRole("textbox", { name: "Email" }) === null; i += 1) {
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    }
  } finally {
    actGlobal.IS_REACT_ACT_ENVIRONMENT = previousAct;
  }

  fireEvent.change(screen.getByRole("textbox", { name: "Email" }), {
    target: { value: GUEST },
  });
  fireEvent.change(screen.getByRole("combobox", { name: "Role" }), {
    target: { value: "role:staff" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send invitation" }));

  expect(within(invitePanel()).queryByRole("alert")?.textContent ?? "").not.toBe(SENTENCE.email);
  expect(await screen.findByText(`Invitation sent to ${GUEST}`)).toBeTruthy();
  const create = calls.find((call) => call.url.includes("/v1/access/invitations/create"));
  expect(create?.body).toEqual({ communitySlug: "parish", email: GUEST, roleKey: "staff" });
});

it("sends a create body with a role only", async () => {
  const { calls } = start({
    permissions: FULL,
    on: (url) => {
      if (url.includes("/v1/access/invitations/create")) {
        return jsonResponse({ invitationId: INVITE_ID }, 201);
      }
      return undefined;
    },
  });
  await mount();
  await fillInvite(GUEST, "role:staff");
  fireEvent.click(screen.getByRole("button", { name: "Send invitation" }));
  await screen.findByText(`Invitation sent to ${GUEST}`);
  const create = calls.find((call) => call.url.includes("/v1/access/invitations/create"));
  expect(create?.url).toBe("https://au.api.example.test/v1/access/invitations/create");
  expect(create?.url).not.toContain(GUEST);
  expect(create?.body).toEqual({ communitySlug: "parish", email: GUEST, roleKey: "staff" });
});

it("sends a create body with a custom role only", async () => {
  const { calls } = start({
    permissions: FULL,
    on: (url) => {
      if (url.includes("/v1/access/invitations/create")) {
        return jsonResponse({ invitationId: INVITE_ID }, 201);
      }
      return undefined;
    },
  });
  await mount();
  await fillInvite(GUEST, `custom:${CUSTOM_ROLE_ID}`);
  fireEvent.click(screen.getByRole("button", { name: "Send invitation" }));
  await screen.findByText(`Invitation sent to ${GUEST}`);
  const create = calls.find((call) => call.url.includes("/v1/access/invitations/create"));
  expect(create?.body).toEqual({
    communitySlug: "parish",
    email: GUEST,
    customRoleId: CUSTOM_ROLE_ID,
  });
});

it("sends a create body with a contact only", async () => {
  const { calls } = start({
    permissions: ["access.users.manage", "access.users.view", "access.roles.view", "people.view"],
    on: (url) => {
      if (url.includes("/v1/people/list")) {
        return jsonResponse({ items: [person("Nia", "Parish")], nextCursor: null });
      }
      if (url.includes("/v1/access/invitations/create")) {
        return jsonResponse({ invitationId: INVITE_ID }, 201);
      }
      return undefined;
    },
  });
  await mount();
  await fillInvite(GUEST);
  await screen.findByRole("heading", { name: "Invite user" });
  const panel = invitePanel();
  fireEvent.change(within(panel).getByRole("textbox", { name: "Contact" }), {
    target: { value: "  Nia  " },
  });
  fireEvent.click(within(panel).getByRole("button", { name: "Search" }));
  fireEvent.click(await within(panel).findByRole("button", { name: "Nia Parish" }));
  fireEvent.click(within(panel).getByRole("button", { name: "Send invitation" }));
  await screen.findByText(`Invitation sent to ${GUEST}`);
  const search = calls.find((call) => call.url.includes("/v1/people/list"));
  expect(search?.body).toEqual({
    communitySlug: "parish",
    kind: "adults",
    search: "Nia",
    limit: 20,
  });
  const create = calls.find((call) => call.url.includes("/v1/access/invitations/create"));
  expect(create?.body).toEqual({ communitySlug: "parish", email: GUEST, personId: PERSON_ID });
});

it("sends a create body with a role and a contact", async () => {
  const { calls } = start({
    permissions: FULL,
    on: (url) => {
      if (url.includes("/v1/people/list")) {
        return jsonResponse({ items: [person("Nia", "Parish")], nextCursor: null });
      }
      if (url.includes("/v1/access/invitations/create")) {
        return jsonResponse({ invitationId: INVITE_ID }, 201);
      }
      return undefined;
    },
  });
  await mount();
  await fillInvite(GUEST, "role:staff");
  const panel = invitePanel();
  fireEvent.change(within(panel).getByRole("textbox", { name: "Contact" }), {
    target: { value: "Nia" },
  });
  fireEvent.click(within(panel).getByRole("button", { name: "Search" }));
  fireEvent.click(await within(panel).findByRole("button", { name: "Nia Parish" }));
  fireEvent.click(within(panel).getByRole("button", { name: "Send invitation" }));
  await screen.findByText(`Invitation sent to ${GUEST}`);
  const create = calls.find((call) => call.url.includes("/v1/access/invitations/create"));
  expect(create?.body).toEqual({
    communitySlug: "parish",
    email: GUEST,
    roleKey: "staff",
    personId: PERSON_ID,
  });
});

it("shows Invitation sent to the typed address, clears the form and reloads pending invitations", async () => {
  let lists = 0;
  const { calls } = start({
    permissions: FULL,
    on: (url) => {
      if (url.includes("/v1/access/invitations/list")) {
        lists += 1;
        return jsonResponse({
          invitations: lists === 1 ? [] : [invitation("queued.guest@example.test")],
        });
      }
      if (url.includes("/v1/access/invitations/create")) {
        return jsonResponse({ invitationId: INVITE_ID }, 201);
      }
      return undefined;
    },
  });
  await mount();
  await fillInvite(`  ${GUEST}  `, "role:staff");
  fireEvent.click(screen.getByRole("button", { name: "Send invitation" }));
  expect(await screen.findByText(`Invitation sent to ${GUEST}`)).toBeTruthy();
  expect(await screen.findByText("queued.guest@example.test")).toBeTruthy();
  const email = within(invitePanel()).getByRole("textbox", { name: "Email" }) as HTMLInputElement;
  expect(email.value).toBe("");
  const role = within(invitePanel()).getByRole("combobox", { name: "Role" }) as HTMLSelectElement;
  expect(role.value).toBe("");
  const create = calls.find((call) => call.url.includes("/v1/access/invitations/create"));
  expect(create?.body).toEqual({ communitySlug: "parish", email: GUEST, roleKey: "staff" });
  expect(lists).toBe(2);
});

it("sends a resend body and reloads the pending panel", async () => {
  let lists = 0;
  const { calls } = start({
    permissions: ["access.users.manage", "access.users.view", "access.roles.view"],
    on: (url, body) => {
      if (url.includes("/v1/access/invitations/list")) {
        lists += 1;
        const slug = typeof body.communitySlug === "string" ? body.communitySlug : "";
        return jsonResponse({
          invitations: [invitation(lists === 1 ? PARISH_EMAIL : "resent.guest@example.test")],
          communitySlug: slug,
        });
      }
      if (url.includes("/v1/access/invitations/resend")) {
        return new Response(null, { status: 204 });
      }
      return undefined;
    },
  });
  await mount();
  fireEvent.click(await screen.findByRole("button", { name: "Resend" }));
  expect(await screen.findByText("resent.guest@example.test")).toBeTruthy();
  const resend = calls.find((call) => call.url.includes("/v1/access/invitations/resend"));
  expect(resend?.url).toBe("https://au.api.example.test/v1/access/invitations/resend");
  expect(resend?.body).toEqual({ communitySlug: "parish", invitationId: INVITE_ID });
  expect(lists).toBe(2);
});

it("sends a revoke body and reloads the pending panel", async () => {
  let lists = 0;
  const { calls } = start({
    permissions: ["access.users.manage", "access.users.view", "access.roles.view"],
    on: (url) => {
      if (url.includes("/v1/access/invitations/list")) {
        lists += 1;
        return jsonResponse({
          invitations: lists === 1 ? [invitation(PARISH_EMAIL)] : [],
        });
      }
      if (url.includes("/v1/access/invitations/revoke")) {
        return new Response(null, { status: 204 });
      }
      return undefined;
    },
  });
  await mount();
  fireEvent.click(await screen.findByRole("button", { name: "Revoke" }));
  expect(await screen.findByText("No pending invitations")).toBeTruthy();
  const revoke = calls.find((call) => call.url.includes("/v1/access/invitations/revoke"));
  expect(revoke?.url).toBe("https://au.api.example.test/v1/access/invitations/revoke");
  expect(revoke?.body).toEqual({ communitySlug: "parish", invitationId: INVITE_ID });
  expect(lists).toBe(2);
});

it("sends a people list body for a trimmed adult search", async () => {
  const { calls } = start({
    permissions: ["access.users.manage", "people.view"],
    on: (url) => {
      if (url.includes("/v1/people/list")) {
        return jsonResponse({ items: [person("Nia", "Parish")], nextCursor: null });
      }
      return undefined;
    },
  });
  await mount();
  await screen.findByRole("heading", { name: "Invite user" });
  const panel = invitePanel();
  fireEvent.change(within(panel).getByRole("textbox", { name: "Contact" }), {
    target: { value: "  Nia  " },
  });
  fireEvent.click(within(panel).getByRole("button", { name: "Search" }));
  expect(await within(panel).findByRole("button", { name: "Nia Parish" })).toBeTruthy();
  const search = calls.find((call) => call.url.includes("/v1/people/list"));
  expect(search?.url).toBe("https://au.api.example.test/v1/people/list");
  expect(search?.url).not.toContain(PERSON_ID);
  expect(search?.body).toEqual({
    communitySlug: "parish",
    kind: "adults",
    search: "Nia",
    limit: 20,
  });
  expect(within(panel).getByRole("list", { name: "Contact results" }).textContent).not.toContain(
    PERSON_ID,
  );
});

it("does not search when the contact query is empty", async () => {
  const { calls } = start({ permissions: ["access.users.manage", "people.view"] });
  await mount();
  await screen.findByRole("heading", { name: "Invite user" });
  fireEvent.click(within(invitePanel()).getByRole("button", { name: "Search" }));
  await act(async () => {});
  expect(calls.some((call) => call.url.includes("/v1/people/list"))).toBe(false);
});

it("does not search when the contact query is longer than 100 characters", async () => {
  const { calls } = start({ permissions: ["access.users.manage", "people.view"] });
  await mount();
  await screen.findByRole("heading", { name: "Invite user" });
  fireEvent.change(within(invitePanel()).getByRole("textbox", { name: "Contact" }), {
    target: { value: "n".repeat(101) },
  });
  fireEvent.click(within(invitePanel()).getByRole("button", { name: "Search" }));
  await act(async () => {});
  expect(calls.some((call) => call.url.includes("/v1/people/list"))).toBe(false);
});

it("shows the permission sentence when a contact search answers 403", async () => {
  start({
    permissions: ["access.users.manage", "people.view"],
    on: (url) => {
      if (url.includes("/v1/people/list")) {
        return jsonResponse({ error: "forbidden" }, 403);
      }
      return undefined;
    },
  });
  await mount();
  await screen.findByRole("heading", { name: "Invite user" });
  const panel = invitePanel();
  fireEvent.change(within(panel).getByRole("textbox", { name: "Contact" }), {
    target: { value: "Nia" },
  });
  fireEvent.click(within(panel).getByRole("button", { name: "Search" }));
  const alert = await within(panel).findByRole("alert");
  expect(alert.textContent).toBe(SENTENCE.permission);
});

it("shows the generic sentence when a contact search fails", async () => {
  start({
    permissions: ["access.users.manage", "people.view"],
    on: (url) => {
      if (url.includes("/v1/people/list")) {
        return jsonResponse({ error: "bad_search" }, 400);
      }
      return undefined;
    },
  });
  await mount();
  await screen.findByRole("heading", { name: "Invite user" });
  const panel = invitePanel();
  fireEvent.change(within(panel).getByRole("textbox", { name: "Contact" }), {
    target: { value: "Nia" },
  });
  fireEvent.click(within(panel).getByRole("button", { name: "Search" }));
  const alert = await within(panel).findByRole("alert");
  expect(alert.textContent).toBe(SENTENCE.generic);
  expect(alert.textContent).not.toBe(SENTENCE.email);
});

it("does not list a minor in the contact results", async () => {
  start({
    permissions: ["access.users.manage", "people.view"],
    on: (url) => {
      if (url.includes("/v1/people/list")) {
        return jsonResponse({
          items: [
            person("Robin", "Child", "00000000-0000-4000-8000-0000000000d2", true),
            person("Nia", "Parish"),
          ],
          nextCursor: null,
        });
      }
      return undefined;
    },
  });
  await mount();
  await screen.findByRole("heading", { name: "Invite user" });
  const panel = invitePanel();
  fireEvent.change(within(panel).getByRole("textbox", { name: "Contact" }), {
    target: { value: "Nia" },
  });
  fireEvent.click(within(panel).getByRole("button", { name: "Search" }));
  expect(await within(panel).findByRole("button", { name: "Nia Parish" })).toBeTruthy();
  expect(within(panel).queryByText("Robin Child")).toBeNull();
  expect(panel.textContent).not.toContain("00000000-0000-4000-8000-0000000000d2");
});

it("sends one invitations list request in StrictMode", async () => {
  const { calls } = start({
    permissions: FULL,
    invitations: () => [invitation(PARISH_EMAIL)],
  });
  await mount(true);
  expect(await screen.findByText(PARISH_EMAIL)).toBeTruthy();
  const lists = calls.filter((call) => call.url.includes("/v1/access/invitations/list"));
  expect(lists).toHaveLength(1);
  expect(lists[0]?.body).toEqual({ communitySlug: "parish" });
});

it("has no axe violations on the invite form and the pending panel", async () => {
  start({
    permissions: FULL,
    invitations: () => [invitation(PARISH_EMAIL)],
  });
  await mount();
  await screen.findByRole("heading", { name: "Invite user" });
  await screen.findByText(PARISH_EMAIL);
  const inviteResults = await axe.run(invitePanel(), {
    rules: { "color-contrast": { enabled: false } },
  });
  const pendingResults = await axe.run(pendingPanel(), {
    rules: { "color-contrast": { enabled: false } },
  });
  expect(resultIds(inviteResults, "violations")).toEqual([]);
  expect(resultIds(pendingResults, "violations")).toEqual([]);
});
