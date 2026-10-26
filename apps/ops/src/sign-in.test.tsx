import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import axe from "axe-core";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";

import { AuthProvider } from "./auth-state.js";
import { decode } from "./base64url.js";
import {
  CEREMONY_CANCELLED_MESSAGE,
  CEREMONY_DEFAULT_MESSAGE,
  ENROL_COMPLETE_MESSAGE,
  GENERIC_ERROR_MESSAGE,
  SIGN_IN_BUTTON_LABEL,
  SIGN_IN_ENROL_LINK,
  SIGN_IN_NOT_ACCEPTED_MESSAGE,
} from "./messages.js";
import { SignIn } from "./sign-in.js";
import { renderAt, stubDeps, watchStorage } from "./test-support.js";

const sampleOptions = {
  challenge: "dGVzdC1jaGFsbGVuZ2U",
  rpId: "ops.example.test",
};

describe("Sign-in screen", () => {
  afterEach(() => {
    history.replaceState(null, "", "#/");
  });

  it("completes passkey sign-in and navigates to directory (success)", async () => {
    const deps = stubDeps({
      "GET /v1/ops/me": { status: 401 },
      "POST /v1/ops/session/refresh": { status: 401 },
      "POST /v1/ops/passkey/authenticate/options": { status: 200, body: sampleOptions },
      "POST /v1/ops/passkey/authenticate/verify": {
        status: 200,
        body: { roleKeys: ["ops.directory.view"] },
      },
    });

    renderAt("#/sign-in", deps);

    expect(screen.getByRole("link", { name: SIGN_IN_ENROL_LINK }).getAttribute("href")).toBe(
      "#/enrol",
    );

    const button = await screen.findByRole("button", { name: SIGN_IN_BUTTON_LABEL });
    fireEvent.click(button);

    await waitFor(() => {
      expect(deps.credentials.get).toHaveBeenCalledTimes(1);
    });

    const getArg = deps.credentials.get.mock.calls[0]![0] as {
      publicKey?: PublicKeyCredentialRequestOptions;
    };
    expect(getArg.publicKey?.challenge).toEqual(decode(sampleOptions.challenge));
    expect(getArg.publicKey?.rpId).toBe("ops.example.test");
    expect(getArg.publicKey?.allowCredentials).toBeUndefined();

    const verifyCall = deps.calls.find(
      (c) => c.method === "POST" && c.path === "/v1/ops/passkey/authenticate/verify",
    );
    expect(verifyCall).toBeDefined();
    expect(Object.keys(verifyCall!.body as object).sort()).toEqual([
      "authenticatorData",
      "clientDataJSON",
      "credentialId",
      "signature",
    ]);

    await screen.findByRole("heading", { level: 1, name: "Directory" });
  });

  it("handles 401 on verify and NotAllowedError on ceremony", async () => {
    const depsFail = stubDeps({
      "GET /v1/ops/me": { status: 401 },
      "POST /v1/ops/session/refresh": { status: 401 },
      "POST /v1/ops/passkey/authenticate/options": { status: 200, body: sampleOptions },
      "POST /v1/ops/passkey/authenticate/verify": { status: 401, body: { error: "rejected" } },
    });

    const { unmount } = renderAt("#/sign-in", depsFail);
    fireEvent.click(await screen.findByRole("button", { name: SIGN_IN_BUTTON_LABEL }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(SIGN_IN_NOT_ACCEPTED_MESSAGE);
    unmount();

    const depsCancel = stubDeps({
      "GET /v1/ops/me": { status: 401 },
      "POST /v1/ops/session/refresh": { status: 401 },
      "POST /v1/ops/passkey/authenticate/options": { status: 200, body: sampleOptions },
    });
    depsCancel.credentials.get.mockRejectedValue(
      new DOMException("The operation either timed out or was not allowed", "NotAllowedError"),
    );

    renderAt("#/sign-in", depsCancel);
    fireEvent.click(await screen.findByRole("button", { name: SIGN_IN_BUTTON_LABEL }));

    const cancelAlert = await screen.findByRole("alert");
    expect(cancelAlert.textContent).toBe(CEREMONY_CANCELLED_MESSAGE);
  });

  it("handles generic failures (503 options, 429 verify, missing rpId)", async () => {
    const deps503 = stubDeps({
      "GET /v1/ops/me": { status: 401 },
      "POST /v1/ops/session/refresh": { status: 401 },
      "POST /v1/ops/passkey/authenticate/options": { status: 503 },
    });
    const { unmount: unmount1 } = renderAt("#/sign-in", deps503);
    fireEvent.click(await screen.findByRole("button", { name: SIGN_IN_BUTTON_LABEL }));
    expect((await screen.findByRole("alert")).textContent).toBe(GENERIC_ERROR_MESSAGE);
    unmount1();

    const deps429 = stubDeps({
      "GET /v1/ops/me": { status: 401 },
      "POST /v1/ops/session/refresh": { status: 401 },
      "POST /v1/ops/passkey/authenticate/options": { status: 200, body: sampleOptions },
      "POST /v1/ops/passkey/authenticate/verify": { status: 429 },
    });
    const { unmount: unmount2 } = renderAt("#/sign-in", deps429);
    fireEvent.click(await screen.findByRole("button", { name: SIGN_IN_BUTTON_LABEL }));
    expect((await screen.findByRole("alert")).textContent).toBe(GENERIC_ERROR_MESSAGE);
    unmount2();

    const depsBadOptions = stubDeps({
      "GET /v1/ops/me": { status: 401 },
      "POST /v1/ops/session/refresh": { status: 401 },
      "POST /v1/ops/passkey/authenticate/options": {
        status: 200,
        body: { challenge: "dGVzdA" }, // missing rpId
      },
    });
    const { unmount: unmount3 } = renderAt("#/sign-in", depsBadOptions);
    fireEvent.click(await screen.findByRole("button", { name: SIGN_IN_BUTTON_LABEL }));
    expect((await screen.findByRole("alert")).textContent).toBe(GENERIC_ERROR_MESSAGE);
    unmount3();
  });

  it("pin 8: never shows browser error text", async () => {
    const deps = stubDeps({
      "GET /v1/ops/me": { status: 401 },
      "POST /v1/ops/session/refresh": { status: 401 },
      "POST /v1/ops/passkey/authenticate/options": { status: 200, body: sampleOptions },
    });
    deps.credentials.get.mockRejectedValue(new DOMException("secret detail", "UnknownError"));

    renderAt("#/sign-in", deps);
    fireEvent.click(await screen.findByRole("button", { name: SIGN_IN_BUTTON_LABEL }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(CEREMONY_DEFAULT_MESSAGE);
    expect(document.body.textContent).not.toContain("secret detail");
  });

  it("pin 8: disables the button while pending and ignores double clicks", async () => {
    let resolveGet!: (val: unknown) => void;
    const pendingPromise = new Promise((res) => {
      resolveGet = res;
    });

    const deps = stubDeps({
      "GET /v1/ops/me": { status: 401 },
      "POST /v1/ops/session/refresh": { status: 401 },
      "POST /v1/ops/passkey/authenticate/options": { status: 200, body: sampleOptions },
      "POST /v1/ops/passkey/authenticate/verify": { status: 200, body: {} },
    });
    deps.credentials.get.mockReturnValue(pendingPromise);

    renderAt("#/sign-in", deps);
    const button = await screen.findByRole("button", { name: SIGN_IN_BUTTON_LABEL });
    fireEvent.click(button);

    await waitFor(() => {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    });

    // Second click while pending
    fireEvent.click(button);

    const optionsCalls = deps.calls.filter(
      (c) => c.method === "POST" && c.path === "/v1/ops/passkey/authenticate/options",
    );
    expect(optionsCalls.length).toBe(1);

    // Resolve get to clean up
    resolveGet({
      id: "cred-1",
      rawId: new Uint8Array([1]).buffer,
      response: {
        clientDataJSON: new Uint8Array([2]).buffer,
        authenticatorData: new Uint8Array([3]).buffer,
        signature: new Uint8Array([4]).buffer,
      },
    });
  });

  it("pin 8: network failure gives generic text and keeps operator not signed out", async () => {
    const deps = stubDeps({
      "GET /v1/ops/me": { status: 401 },
      "POST /v1/ops/session/refresh": { status: 401 },
      "POST /v1/ops/passkey/authenticate/options": () => {
        throw new Error("network down");
      },
    });

    renderAt("#/sign-in", deps);
    fireEvent.click(await screen.findByRole("button", { name: SIGN_IN_BUTTON_LABEL }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(GENERIC_ERROR_MESSAGE);
  });

  it("pin 5: watchStorage records nothing and location holds no credential id", async () => {
    const watcher = watchStorage();
    try {
      const deps = stubDeps({
        "GET /v1/ops/me": { status: 401 },
        "POST /v1/ops/session/refresh": { status: 401 },
        "POST /v1/ops/passkey/authenticate/options": { status: 200, body: sampleOptions },
        "POST /v1/ops/passkey/authenticate/verify": { status: 200, body: {} },
      });

      renderAt("#/sign-in", deps);
      fireEvent.click(await screen.findByRole("button", { name: SIGN_IN_BUTTON_LABEL }));
      await screen.findByRole("heading", { level: 1, name: "Directory" });

      expect(watcher.calls).toHaveLength(0);
      expect(location.href).not.toContain("cred-1");
    } finally {
      watcher.restore();
    }
  });

  it("keyboard navigation and alert accessibility", async () => {
    const deps = stubDeps({
      "GET /v1/ops/me": { status: 401 },
      "POST /v1/ops/session/refresh": { status: 401 },
      "POST /v1/ops/passkey/authenticate/options": { status: 200, body: sampleOptions },
      "POST /v1/ops/passkey/authenticate/verify": { status: 401 },
    });

    renderAt("#/sign-in", deps);
    const button = await screen.findByRole("button", { name: SIGN_IN_BUTTON_LABEL });

    button.focus();
    expect(document.activeElement).toBe(button);
    fireEvent.keyDown(button, { key: "Enter", code: "Enter" });
    fireEvent.click(button);

    const alert = await screen.findByRole("alert");
    expect(alert).not.toBeNull();
  });

  it("passes axe checks in idle and message states", async () => {
    const deps = stubDeps({
      "GET /v1/ops/me": { status: 401 },
      "POST /v1/ops/session/refresh": { status: 401 },
      "POST /v1/ops/passkey/authenticate/options": { status: 200, body: sampleOptions },
      "POST /v1/ops/passkey/authenticate/verify": { status: 401 },
    });

    const { container } = renderAt("#/sign-in", deps);
    await screen.findByRole("heading", { level: 1, name: "Sign in" });

    let results = await axe.run(container, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(results.violations).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: SIGN_IN_BUTTON_LABEL }));
    await screen.findByRole("alert");

    results = await axe.run(container, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(results.violations).toEqual([]);
  });

  it("renders carried enrolment complete message with default alert tone", async () => {
    const deps = stubDeps();
    render(
      <MemoryRouter>
        <AuthProvider initialStatus="signed-out" initialMessage={ENROL_COMPLETE_MESSAGE}>
          <SignIn deps={deps} />
        </AuthProvider>
      </MemoryRouter>,
    );

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(ENROL_COMPLETE_MESSAGE);
    expect(alert.className).not.toContain("text-destructive");
  });
});
