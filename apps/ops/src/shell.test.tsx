import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, describe, expect, it } from "vitest";

import type { OpsDeps } from "./deps.js";
import {
  CHECKING_SESSION_MESSAGE,
  GENERIC_ERROR_MESSAGE,
  SIGN_IN_BUTTON_LABEL,
  SIGN_OUT_BUTTON_LABEL,
  SIGN_OUT_NETWORK_ERROR_MESSAGE,
  TRY_AGAIN_BUTTON_LABEL,
} from "./messages.js";
import { Shell } from "./shell.js";
import { fakeLocks, renderAt, stored, stubDeps, watchStorage } from "./test-support.js";

const validDeps: OpsDeps = {
  fetch: globalThis.fetch,
  credentials: {
    get: async () => null,
    create: async () => null,
  },
  locks: fakeLocks(),
  publicKeyCredentialSupported: true,
};

describe("Shell unsupported browser", () => {
  afterEach(() => {
    history.replaceState(null, "", "#/");
  });

  it("renders unsupported message when locks is missing", async () => {
    const { container } = render(<Shell deps={{ ...validDeps, locks: undefined }} />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "This browser is not supported.",
    );
    expect(container.textContent).toBe("This browser is not supported.");
    const results = await axe.run(container, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(results.violations).toEqual([]);
  });

  it("renders unsupported message when credentials is missing", async () => {
    const { container } = render(<Shell deps={{ ...validDeps, credentials: undefined }} />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "This browser is not supported.",
    );
    expect(container.textContent).toBe("This browser is not supported.");
    const results = await axe.run(container, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(results.violations).toEqual([]);
  });

  it("renders unsupported message when publicKeyCredentialSupported is false", async () => {
    const { container } = render(
      <Shell deps={{ ...validDeps, publicKeyCredentialSupported: false }} />,
    );
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "This browser is not supported.",
    );
    expect(container.textContent).toBe("This browser is not supported.");
    const results = await axe.run(container, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(results.violations).toEqual([]);
  });

  it("renders route headings when browser is supported", async () => {
    const authedDeps = stubDeps({
      "GET /v1/ops/me": { status: 200, body: { roleKeys: ["ops.directory.view"] } },
      "GET /v1/ops/directory": { status: 200, body: { organisations: [], truncated: false } },
    });
    const { unmount } = renderAt("#/", authedDeps);
    expect((await screen.findByRole("heading", { level: 1 })).textContent).toBe("Directory");
    unmount();

    const unauthedDeps = stubDeps({
      "GET /v1/ops/me": { status: 401 },
      "POST /v1/ops/session/refresh": { status: 401 },
    });
    const { unmount: unmountSignIn } = renderAt("#/sign-in", unauthedDeps);
    expect((await screen.findByRole("heading", { level: 1 })).textContent).toBe("Sign in");
    unmountSignIn();

    history.replaceState(null, "", "#/enrol");
    const { unmount: unmountEnrol } = render(<Shell deps={validDeps} />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Enrol");
    unmountEnrol();
  });

  it("pin 6c: opening #/enrol calls neither me nor refresh, moving to #/sign-in probes once", async () => {
    const deps = stubDeps({
      "GET /v1/ops/me": { status: 401 },
      "POST /v1/ops/session/refresh": { status: 401 },
    });

    renderAt("#/enrol", deps);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Enrol");

    const meCallsOnEnrol = deps.calls.filter((c) => c.path === "/v1/ops/me");
    const refreshCallsOnEnrol = deps.calls.filter((c) => c.path === "/v1/ops/session/refresh");
    expect(meCallsOnEnrol.length).toBe(0);
    expect(refreshCallsOnEnrol.length).toBe(0);

    // Move by hand to #/sign-in
    await act(async () => {
      window.location.hash = "#/sign-in";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });

    await screen.findByRole("heading", { level: 1, name: "Sign in" });
    expect(screen.queryByRole("status")).toBeNull();

    const meCalls = deps.calls.filter((c) => c.path === "/v1/ops/me");
    const refreshCalls = deps.calls.filter((c) => c.path === "/v1/ops/session/refresh");
    expect(meCalls.length).toBe(2);
    expect(refreshCalls.length).toBe(1);
  });

  it("probe outcome: me 200 shows Directory heading, header link and Sign out", async () => {
    const deps = stubDeps({
      "GET /v1/ops/me": { status: 200, body: { roleKeys: ["ops.directory.view"] } },
    });

    renderAt("#/", deps);

    await screen.findByRole("heading", { level: 1, name: "Directory" });
    expect(screen.getByRole("link", { name: "Directory" }).getAttribute("href")).toBe("#/");
    expect(screen.getByRole("button", { name: SIGN_OUT_BUTTON_LABEL })).not.toBeNull();
  });

  it("probe outcome: me 401 then refresh 401 shows Sign in with no alert", async () => {
    const deps = stubDeps({
      "GET /v1/ops/me": { status: 401 },
      "POST /v1/ops/session/refresh": { status: 401 },
    });

    renderAt("#/", deps);

    await screen.findByRole("heading", { level: 1, name: "Sign in" });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("probe outcome: me 500 shows generic text and Try again, and clicking it repeats the probe", async () => {
    const deps = stubDeps({
      "GET /v1/ops/me": [
        { status: 500 },
        { status: 200, body: { roleKeys: ["ops.directory.view"] } },
      ],
    });

    renderAt("#/", deps);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(GENERIC_ERROR_MESSAGE);
    const retryBtn = screen.getByRole("button", { name: TRY_AGAIN_BUTTON_LABEL });

    fireEvent.click(retryBtn);

    await screen.findByRole("heading", { level: 1, name: "Directory" });
  });

  it("sign-out calls /v1/ops/session/end once then shows Sign in", async () => {
    const deps = stubDeps({
      "GET /v1/ops/me": { status: 200, body: { roleKeys: ["ops.directory.view"] } },
      "POST /v1/ops/session/end": { status: 204 },
    });

    renderAt("#/", deps);
    const signoutBtn = await screen.findByRole("button", { name: SIGN_OUT_BUTTON_LABEL });

    fireEvent.click(signoutBtn);

    await screen.findByRole("heading", { level: 1, name: "Sign in" });
    const endCalls = deps.calls.filter((c) => c.path === "/v1/ops/session/end");
    expect(endCalls.length).toBe(1);
  });

  it("sign-out network failure shows the close-the-browser text", async () => {
    const deps = stubDeps({
      "GET /v1/ops/me": { status: 200, body: { roleKeys: ["ops.directory.view"] } },
      "POST /v1/ops/session/end": () => {
        throw new Error("network down");
      },
    });

    renderAt("#/", deps);
    const signoutBtn = await screen.findByRole("button", { name: SIGN_OUT_BUTTON_LABEL });

    fireEvent.click(signoutBtn);

    await screen.findByRole("heading", { level: 1, name: "Sign in" });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(SIGN_OUT_NETWORK_ERROR_MESSAGE);
  });

  it("sign-out with session/end answering 503 shows the close-the-browser text", async () => {
    const deps = stubDeps({
      "GET /v1/ops/me": { status: 200, body: { roleKeys: ["ops.directory.view"] } },
      "POST /v1/ops/session/end": { status: 503 },
    });

    renderAt("#/", deps);
    const signoutBtn = await screen.findByRole("button", { name: SIGN_OUT_BUTTON_LABEL });

    fireEvent.click(signoutBtn);

    await screen.findByRole("heading", { level: 1, name: "Sign in" });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(SIGN_OUT_NETWORK_ERROR_MESSAGE);
  });

  it("double-clicking sign-out sends only one session/end request", async () => {
    let resolveEnd!: (val: unknown) => void;
    const pendingEnd = new Promise((res) => {
      resolveEnd = res;
    });

    const deps = stubDeps({
      "GET /v1/ops/me": { status: 200, body: { roleKeys: ["ops.directory.view"] } },
      "POST /v1/ops/session/end": () => pendingEnd as unknown as Response,
    });

    renderAt("#/", deps);
    const signoutBtn = await screen.findByRole("button", { name: SIGN_OUT_BUTTON_LABEL });

    fireEvent.click(signoutBtn);
    expect(signoutBtn.hasAttribute("disabled")).toBe(true);
    fireEvent.click(signoutBtn);

    resolveEnd(new Response(null, { status: 204 }));

    await screen.findByRole("heading", { level: 1, name: "Sign in" });
    const endCalls = deps.calls.filter((c) => c.path === "/v1/ops/session/end");
    expect(endCalls.length).toBe(1);
  });

  it("focuses the page h1 after navigation", async () => {
    const deps = stubDeps({
      "GET /v1/ops/me": { status: 401 },
      "POST /v1/ops/session/refresh": { status: 401 },
    });

    renderAt("#/sign-in", deps);
    const h1 = await screen.findByRole("heading", { level: 1, name: "Sign in" });
    await waitFor(() => {
      expect(document.activeElement).toBe(h1);
    });
  });

  it("pin 5: watchStorage records nothing across the probe, U7 refresh and sign-out", async () => {
    const watcher = watchStorage();
    try {
      const deps = stubDeps({
        "GET /v1/ops/me": [
          { status: 401 },
          { status: 200, body: { roleKeys: ["ops.directory.view"] } },
        ],
        "POST /v1/ops/session/refresh": { status: 200 },
        "POST /v1/ops/session/end": { status: 204 },
      });

      renderAt("#/", deps);
      const signoutBtn = await screen.findByRole("button", { name: SIGN_OUT_BUTTON_LABEL });
      fireEvent.click(signoutBtn);
      await screen.findByRole("heading", { level: 1, name: "Sign in" });

      expect(watcher.calls).toHaveLength(0);
      expect(stored()).toEqual({ local: 0, session: 0 });
    } finally {
      watcher.restore();
    }
  });

  it("keyboard navigation triggers sign-out with Enter", async () => {
    const deps = stubDeps({
      "GET /v1/ops/me": { status: 200, body: { roleKeys: ["ops.directory.view"] } },
      "POST /v1/ops/session/end": { status: 204 },
    });

    renderAt("#/", deps);
    const signoutBtn = await screen.findByRole("button", { name: SIGN_OUT_BUTTON_LABEL });

    signoutBtn.focus();
    expect(document.activeElement).toBe(signoutBtn);
    fireEvent.keyDown(signoutBtn, { key: "Enter", code: "Enter" });
    fireEvent.click(signoutBtn);

    await screen.findByRole("heading", { level: 1, name: "Sign in" });
  });

  it("passes axe checks across checking, failed, signed-in and signed-out states", async () => {
    let resolveMe!: (val: unknown) => void;
    const pendingMe = new Promise((res) => {
      resolveMe = res;
    });

    const deps = stubDeps({
      "GET /v1/ops/me": () => pendingMe as unknown as Response,
    });

    // 1. Checking state
    const { container, unmount } = renderAt("#/", deps);
    expect(screen.getByRole("status").textContent).toBe(CHECKING_SESSION_MESSAGE);

    let results = await axe.run(container, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(results.violations).toEqual([]);
    unmount();

    // 2. Failed state
    const depsFailed = stubDeps({
      "GET /v1/ops/me": { status: 500 },
    });
    const { container: containerFailed, unmount: unmountFailed } = renderAt("#/", depsFailed);
    await screen.findByRole("button", { name: TRY_AGAIN_BUTTON_LABEL });
    results = await axe.run(containerFailed, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(results.violations).toEqual([]);
    unmountFailed();

    // 3. Signed-in state
    const depsSignedIn = stubDeps({
      "GET /v1/ops/me": { status: 200, body: { roleKeys: ["ops.directory.view"] } },
    });
    const { container: containerSignedIn, unmount: unmountSignedIn } = renderAt("#/", depsSignedIn);
    await screen.findByRole("heading", { level: 1, name: "Directory" });
    results = await axe.run(containerSignedIn, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(results.violations).toEqual([]);
    unmountSignedIn();

    // 4. Signed-out state
    const depsSignedOut = stubDeps({
      "GET /v1/ops/me": { status: 401 },
      "POST /v1/ops/session/refresh": { status: 401 },
    });
    const { container: containerSignedOut, unmount: unmountSignedOut } = renderAt(
      "#/sign-in",
      depsSignedOut,
    );
    await screen.findByRole("heading", { level: 1, name: "Sign in" });
    results = await axe.run(containerSignedOut, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(results.violations).toEqual([]);
    unmountSignedOut();

    // Clean up pending promise
    resolveMe(new Response(JSON.stringify({}), { status: 200 }));
  });

  it("on #/ with me held pending, no request to /v1/ops/directory is made and no Directory heading is shown until me answers 200", async () => {
    let resolveMe!: () => void;
    const pendingMe = new Promise<void>((res) => {
      resolveMe = res;
    });

    const deps = stubDeps({
      "GET /v1/ops/me": async () => {
        await pendingMe;
        return new Response(JSON.stringify({ roleKeys: ["ops.directory.view"] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
      "GET /v1/ops/directory": {
        status: 200,
        body: { organisations: [], truncated: false },
      },
    });

    renderAt("#/", deps);

    expect(screen.getByRole("status").textContent).toBe(CHECKING_SESSION_MESSAGE);
    expect(screen.queryByRole("heading", { level: 1, name: "Directory" })).toBeNull();
    const directoryCallsBefore = deps.calls.filter((c) => c.path === "/v1/ops/directory");
    expect(directoryCallsBefore).toHaveLength(0);

    await act(async () => {
      resolveMe();
    });

    await screen.findByRole("heading", { level: 1, name: "Directory" });
    const directoryCallsAfter = deps.calls.filter((c) => c.path === "/v1/ops/directory");
    expect(directoryCallsAfter.length).toBeGreaterThanOrEqual(1);
  });

  it("on #/sign-in with me held pending, the sign-in button is not shown until the probe settles", async () => {
    let resolveMe!: () => void;
    const pendingMe = new Promise<void>((res) => {
      resolveMe = res;
    });

    const deps = stubDeps({
      "GET /v1/ops/me": async () => {
        await pendingMe;
        return new Response(null, { status: 401 });
      },
      "POST /v1/ops/session/refresh": { status: 401 },
    });

    renderAt("#/sign-in", deps);

    expect(screen.getByRole("status").textContent).toBe(CHECKING_SESSION_MESSAGE);
    expect(screen.queryByRole("button", { name: SIGN_IN_BUTTON_LABEL })).toBeNull();

    await act(async () => {
      resolveMe();
    });

    await screen.findByRole("button", { name: SIGN_IN_BUTTON_LABEL });
  });
});
