import { act, fireEvent, render, screen } from "@testing-library/react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AuthProvider } from "./auth-state.js";
import type { OpsDeps } from "./deps.js";
import { ErrorBoundary } from "./error-boundary.js";
import {
  CEREMONY_CANCELLED_MESSAGE,
  CEREMONY_SAME_DEVICE_MESSAGE,
  DIRECTORY_TRUNCATED_MESSAGE,
  ENROL_ALREADY_ACTIVE_MESSAGE,
  ENROL_COMPLETE_MESSAGE,
  ENROL_CREATE_PASSKEY_BUTTON_LABEL,
  ENROL_EMAIL_CODE_LABEL,
  ENROL_EMAIL_LABEL,
  ENROL_ENROLMENT_CODE_LABEL,
  ENROL_PASSKEY_NOT_SAVED_MESSAGE,
  ENROL_SEND_CODE_BUTTON_LABEL,
  ENROL_SESSION_ENDED_MESSAGE,
  ENROL_STEP_1_HEADING,
  ENROL_STEP_2_HEADING,
  ENROL_STEP_3_HEADING,
  ENROL_STEP_4_HEADING,
  ENROL_VERIFY_BUTTON_LABEL,
  ENROL_WRONG_CODES_MESSAGE,
  SESSION_ENDED_MESSAGE,
  SIGN_IN_BUTTON_LABEL,
  SIGN_IN_NOT_ACCEPTED_MESSAGE,
  SIGN_OUT_NETWORK_ERROR_MESSAGE,
  TRY_AGAIN_BUTTON_LABEL,
} from "./messages.js";
import { rootOptions } from "./root-options.js";
import { Shell } from "./shell.js";
import { SignIn } from "./sign-in.js";
import { fakeLocks, renderAt, stubDeps } from "./test-support.js";

const validDeps: OpsDeps = {
  fetch: globalThis.fetch,
  credentials: {
    get: async () => null,
    create: async () => null,
  },
  locks: fakeLocks(),
  publicKeyCredentialSupported: true,
};

const sampleOptions = {
  challenge: "dGVzdC1jaGFsbGVuZ2U",
  rpId: "ops.example.test",
};

const sampleRegisterOptions = {
  challenge: "dGVzdC1jaGFsbGVuZ2U",
  rp: { id: "ops.example.test", name: "Community Hub operations" },
  user: { id: "dXNlci0x", name: "Community Hub operator", displayName: "Community Hub operator" },
  pubKeyCredParams: [{ type: "public-key" as const, alg: -7 }],
  attestation: "none" as const,
  authenticatorSelection: {
    userVerification: "preferred" as const,
    residentKey: "required" as const,
  },
  excludeCredentials: [],
};

const sampleDirectory = {
  organisations: [
    {
      id: "00000000-0000-4000-8000-000000000001",
      slug: "org-alpha",
      kind: "parish",
      region: "ap-southeast-2",
      communities: [{ id: "00000000-0000-4000-8000-000000000011", slug: "community-one" }],
    },
  ],
  truncated: false,
};

function Bomb(): never {
  throw new Error("test bomb");
}

describe("No injected styles across every screen (pin 3)", () => {
  afterEach(() => {
    history.replaceState(null, "", "#/");
  });

  it("no screen state injects a style element, rule or attribute", async () => {
    const styleElementCalls: unknown[] = [];
    const insertRuleCalls: unknown[] = [];
    const adoptedStyleSheetsWrites: unknown[] = [];
    const styleAttributeCalls: unknown[] = [];

    // 1. Spy on document.createElement
    const origCreateElement = document.createElement.bind(document);
    const createElementSpy = vi
      .spyOn(document, "createElement")
      .mockImplementation((tagName: string, options?: ElementCreationOptions) => {
        if (tagName.toLowerCase() === "style") {
          styleElementCalls.push({ tagName, options });
        }
        return origCreateElement(tagName, options);
      });

    // 2. Spy on CSSStyleSheet.prototype.insertRule
    const insertRuleSpy = vi
      .spyOn(CSSStyleSheet.prototype, "insertRule")
      .mockImplementation(function (this: CSSStyleSheet, rule: string, index?: number) {
        insertRuleCalls.push({ rule, index });
        return 0;
      });

    // 3. Spy on document.adoptedStyleSheets writes
    let originalAdopted = Object.getOwnPropertyDescriptor(Document.prototype, "adoptedStyleSheets");
    let targetObj: object = Document.prototype;
    if (!originalAdopted) {
      originalAdopted = Object.getOwnPropertyDescriptor(document, "adoptedStyleSheets");
      targetObj = document;
    }
    let currentAdopted: unknown = [];
    Object.defineProperty(targetObj, "adoptedStyleSheets", {
      configurable: true,
      get() {
        return currentAdopted;
      },
      set(v) {
        adoptedStyleSheetsWrites.push(v);
        currentAdopted = v;
      },
    });

    // 4. Spy on Element.prototype.setAttribute
    const origSetAttribute = Element.prototype.setAttribute;
    const setAttributeSpy = vi
      .spyOn(Element.prototype, "setAttribute")
      .mockImplementation(function (this: Element, qualifiedName: string, value: string) {
        if (qualifiedName.toLowerCase() === "style") {
          styleAttributeCalls.push({ element: this.tagName, value });
        }
        return origSetAttribute.call(this, qualifiedName, value);
      });

    try {
      // State 1: Unsupported browser
      const { unmount: unmountUnsupported } = render(
        <Shell deps={{ ...validDeps, locks: undefined }} />,
      );
      expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
        "This browser is not supported.",
      );
      unmountUnsupported();

      // State 2: Probe checking
      let resolveCheckingMe!: (val: unknown) => void;
      const pendingCheckingMe = new Promise((res) => {
        resolveCheckingMe = res;
      });
      const depsChecking = stubDeps({
        "GET /v1/ops/me": () => pendingCheckingMe as unknown as Response,
      });
      const { unmount: unmountChecking } = renderAt("#/", depsChecking);
      expect(screen.getByRole("status")).not.toBeNull();
      unmountChecking();
      resolveCheckingMe(new Response(null, { status: 401 }));

      // State 3: Probe failed
      const depsProbeFailed = stubDeps({
        "GET /v1/ops/me": { status: 500 },
      });
      const { unmount: unmountProbeFailed } = renderAt("#/", depsProbeFailed);
      await screen.findByRole("button", { name: TRY_AGAIN_BUTTON_LABEL });
      unmountProbeFailed();

      // State 4: Probe signed-out & State 5: Sign-in idle
      const depsSignIn = stubDeps({
        "GET /v1/ops/me": { status: 401 },
        "POST /v1/ops/session/refresh": { status: 401 },
      });
      const { unmount: unmountSignIn } = renderAt("#/sign-in", depsSignIn);
      const signInBtn = await screen.findByRole("button", { name: SIGN_IN_BUTTON_LABEL });
      expect(signInBtn).not.toBeNull();

      // State 6: Sign-in pending
      let resolveOptions!: (val: unknown) => void;
      const pendingOptions = new Promise((res) => {
        resolveOptions = res;
      });
      const depsSignInPending = stubDeps({
        "GET /v1/ops/me": { status: 401 },
        "POST /v1/ops/session/refresh": { status: 401 },
        "POST /v1/ops/passkey/authenticate/options": () => pendingOptions as unknown as Response,
      });
      const { unmount: unmountSignInPending } = renderAt("#/sign-in", depsSignInPending);
      const pendingSignInBtn = await screen.findByRole("button", { name: SIGN_IN_BUTTON_LABEL });
      fireEvent.click(pendingSignInBtn);
      expect(pendingSignInBtn.hasAttribute("disabled")).toBe(true);
      unmountSignInPending();
      resolveOptions(new Response(JSON.stringify(sampleOptions), { status: 200 }));
      unmountSignIn();

      // State 6b: Sign-in with each carried message
      const carriedMessages = [
        SESSION_ENDED_MESSAGE,
        ENROL_COMPLETE_MESSAGE,
        ENROL_ALREADY_ACTIVE_MESSAGE,
        SIGN_OUT_NETWORK_ERROR_MESSAGE,
      ];
      for (const msg of carriedMessages) {
        const { unmount: unmountCarried } = render(
          <MemoryRouter>
            <AuthProvider initialStatus="signed-out" initialMessage={msg}>
              <SignIn deps={validDeps} />
            </AuthProvider>
          </MemoryRouter>,
        );
        await screen.findByText(msg);
        unmountCarried();
      }

      // State 6c: Sign-in with its own error text
      const depsSignInError = stubDeps({
        "POST /v1/ops/passkey/authenticate/options": { status: 200, body: sampleOptions },
        "POST /v1/ops/passkey/authenticate/verify": { status: 401 },
      });
      const { unmount: unmountSignInError } = render(
        <MemoryRouter>
          <AuthProvider initialStatus="signed-out">
            <SignIn deps={depsSignInError} />
          </AuthProvider>
        </MemoryRouter>,
      );
      fireEvent.click(await screen.findByRole("button", { name: SIGN_IN_BUTTON_LABEL }));
      await screen.findByText(SIGN_IN_NOT_ACCEPTED_MESSAGE);
      unmountSignInError();

      // State 7: Enrolment steps 1-4
      const depsEnrol = stubDeps({
        "POST /v1/ops/enrolment/start": { status: 204 },
        "POST /v1/ops/enrolment/verify": { status: 200, body: { status: "enrolment" } },
        "POST /v1/ops/passkey/register/options": { status: 200, body: sampleRegisterOptions },
        "POST /v1/ops/passkey/register/verify": { status: 200, body: { activated: false } },
      });
      const { unmount: unmountEnrol } = renderAt("#/enrol", depsEnrol);

      // Step 1
      await screen.findByRole("heading", { level: 1, name: ENROL_STEP_1_HEADING });
      fireEvent.change(screen.getByLabelText(ENROL_EMAIL_LABEL), {
        target: { value: "operator@example.test" },
      });
      fireEvent.click(screen.getByRole("button", { name: ENROL_SEND_CODE_BUTTON_LABEL }));

      // Step 2
      await screen.findByRole("heading", { level: 1, name: ENROL_STEP_2_HEADING });
      fireEvent.change(screen.getByLabelText(ENROL_EMAIL_CODE_LABEL), {
        target: { value: "12345678" },
      });
      fireEvent.change(screen.getByLabelText(ENROL_ENROLMENT_CODE_LABEL), {
        target: { value: "ABCD-EFGH" },
      });
      fireEvent.click(screen.getByRole("button", { name: ENROL_VERIFY_BUTTON_LABEL }));

      // Step 3
      await screen.findByRole("heading", { level: 1, name: ENROL_STEP_3_HEADING });
      fireEvent.click(screen.getByRole("button", { name: ENROL_CREATE_PASSKEY_BUTTON_LABEL }));

      // Step 4
      await screen.findByRole("heading", { level: 1, name: ENROL_STEP_4_HEADING });
      unmountEnrol();

      // State 7b: Enrolment error - wrong codes
      const depsWrongCodes = stubDeps({
        "POST /v1/ops/enrolment/start": { status: 204 },
        "POST /v1/ops/enrolment/verify": { status: 401 },
      });
      const { unmount: unmountWrongCodes } = renderAt("#/enrol", depsWrongCodes);
      fireEvent.change(await screen.findByLabelText(ENROL_EMAIL_LABEL), {
        target: { value: "operator@example.test" },
      });
      fireEvent.click(screen.getByRole("button", { name: ENROL_SEND_CODE_BUTTON_LABEL }));
      await screen.findByRole("heading", { level: 1, name: ENROL_STEP_2_HEADING });
      fireEvent.change(screen.getByLabelText(ENROL_EMAIL_CODE_LABEL), {
        target: { value: "12345678" },
      });
      fireEvent.change(screen.getByLabelText(ENROL_ENROLMENT_CODE_LABEL), {
        target: { value: "ABCD-EFGH" },
      });
      fireEvent.click(screen.getByRole("button", { name: ENROL_VERIFY_BUTTON_LABEL }));
      await screen.findByText(ENROL_WRONG_CODES_MESSAGE);
      unmountWrongCodes();

      // State 7c: Enrolment error - enrolment session ended
      const depsSessionEnded = stubDeps({
        "POST /v1/ops/enrolment/start": { status: 204 },
        "POST /v1/ops/enrolment/verify": { status: 200, body: { status: "enrolment" } },
        "POST /v1/ops/passkey/register/options": { status: 401 },
      });
      const { unmount: unmountSessionEnded } = renderAt("#/enrol", depsSessionEnded);
      fireEvent.change(await screen.findByLabelText(ENROL_EMAIL_LABEL), {
        target: { value: "operator@example.test" },
      });
      fireEvent.click(screen.getByRole("button", { name: ENROL_SEND_CODE_BUTTON_LABEL }));
      await screen.findByRole("heading", { level: 1, name: ENROL_STEP_2_HEADING });
      fireEvent.change(screen.getByLabelText(ENROL_EMAIL_CODE_LABEL), {
        target: { value: "12345678" },
      });
      fireEvent.change(screen.getByLabelText(ENROL_ENROLMENT_CODE_LABEL), {
        target: { value: "ABCD-EFGH" },
      });
      fireEvent.click(screen.getByRole("button", { name: ENROL_VERIFY_BUTTON_LABEL }));
      await screen.findByRole("heading", { level: 1, name: ENROL_STEP_3_HEADING });
      fireEvent.click(screen.getByRole("button", { name: ENROL_CREATE_PASSKEY_BUTTON_LABEL }));
      await screen.findByText(ENROL_SESSION_ENDED_MESSAGE);
      unmountSessionEnded();

      // State 7d: Enrolment error - not saved
      const depsNotSaved = stubDeps({
        "POST /v1/ops/enrolment/start": { status: 204 },
        "POST /v1/ops/enrolment/verify": { status: 200, body: { status: "enrolment" } },
        "POST /v1/ops/passkey/register/options": { status: 200, body: sampleRegisterOptions },
        "POST /v1/ops/passkey/register/verify": { status: 400 },
      });
      const { unmount: unmountNotSaved } = renderAt("#/enrol", depsNotSaved);
      fireEvent.change(await screen.findByLabelText(ENROL_EMAIL_LABEL), {
        target: { value: "operator@example.test" },
      });
      fireEvent.click(screen.getByRole("button", { name: ENROL_SEND_CODE_BUTTON_LABEL }));
      await screen.findByRole("heading", { level: 1, name: ENROL_STEP_2_HEADING });
      fireEvent.change(screen.getByLabelText(ENROL_EMAIL_CODE_LABEL), {
        target: { value: "12345678" },
      });
      fireEvent.change(screen.getByLabelText(ENROL_ENROLMENT_CODE_LABEL), {
        target: { value: "ABCD-EFGH" },
      });
      fireEvent.click(screen.getByRole("button", { name: ENROL_VERIFY_BUTTON_LABEL }));
      await screen.findByRole("heading", { level: 1, name: ENROL_STEP_3_HEADING });
      fireEvent.click(screen.getByRole("button", { name: ENROL_CREATE_PASSKEY_BUTTON_LABEL }));
      await screen.findByText(ENROL_PASSKEY_NOT_SAVED_MESSAGE);
      unmountNotSaved();

      // State 7e: Enrolment error - same device
      const depsSameDevice = stubDeps({
        "POST /v1/ops/enrolment/start": { status: 204 },
        "POST /v1/ops/enrolment/verify": { status: 200, body: { status: "enrolment" } },
        "POST /v1/ops/passkey/register/options": { status: 200, body: sampleRegisterOptions },
      });
      depsSameDevice.credentials.create = vi
        .fn()
        .mockRejectedValue(
          new DOMException("The authenticator was already registered", "InvalidStateError"),
        );
      const { unmount: unmountSameDevice } = renderAt("#/enrol", depsSameDevice);
      fireEvent.change(await screen.findByLabelText(ENROL_EMAIL_LABEL), {
        target: { value: "operator@example.test" },
      });
      fireEvent.click(screen.getByRole("button", { name: ENROL_SEND_CODE_BUTTON_LABEL }));
      await screen.findByRole("heading", { level: 1, name: ENROL_STEP_2_HEADING });
      fireEvent.change(screen.getByLabelText(ENROL_EMAIL_CODE_LABEL), {
        target: { value: "12345678" },
      });
      fireEvent.change(screen.getByLabelText(ENROL_ENROLMENT_CODE_LABEL), {
        target: { value: "ABCD-EFGH" },
      });
      fireEvent.click(screen.getByRole("button", { name: ENROL_VERIFY_BUTTON_LABEL }));
      await screen.findByRole("heading", { level: 1, name: ENROL_STEP_3_HEADING });
      fireEvent.click(screen.getByRole("button", { name: ENROL_CREATE_PASSKEY_BUTTON_LABEL }));
      await screen.findByText(CEREMONY_SAME_DEVICE_MESSAGE);
      unmountSameDevice();

      // State 7f: Enrolment error - cancelled
      const depsCancelled = stubDeps({
        "POST /v1/ops/enrolment/start": { status: 204 },
        "POST /v1/ops/enrolment/verify": { status: 200, body: { status: "enrolment" } },
        "POST /v1/ops/passkey/register/options": { status: 200, body: sampleRegisterOptions },
      });
      depsCancelled.credentials.create = vi
        .fn()
        .mockRejectedValue(new DOMException("User cancelled", "NotAllowedError"));
      const { unmount: unmountCancelled } = renderAt("#/enrol", depsCancelled);
      fireEvent.change(await screen.findByLabelText(ENROL_EMAIL_LABEL), {
        target: { value: "operator@example.test" },
      });
      fireEvent.click(screen.getByRole("button", { name: ENROL_SEND_CODE_BUTTON_LABEL }));
      await screen.findByRole("heading", { level: 1, name: ENROL_STEP_2_HEADING });
      fireEvent.change(screen.getByLabelText(ENROL_EMAIL_CODE_LABEL), {
        target: { value: "12345678" },
      });
      fireEvent.change(screen.getByLabelText(ENROL_ENROLMENT_CODE_LABEL), {
        target: { value: "ABCD-EFGH" },
      });
      fireEvent.click(screen.getByRole("button", { name: ENROL_VERIFY_BUTTON_LABEL }));
      await screen.findByRole("heading", { level: 1, name: ENROL_STEP_3_HEADING });
      fireEvent.click(screen.getByRole("button", { name: ENROL_CREATE_PASSKEY_BUTTON_LABEL }));
      await screen.findByText(CEREMONY_CANCELLED_MESSAGE);
      unmountCancelled();

      // State 8: Directory loading
      let resolveDir!: (val: unknown) => void;
      const pendingDir = new Promise((res) => {
        resolveDir = res;
      });
      const depsDirLoading = stubDeps({
        "GET /v1/ops/me": { status: 200, body: { roleKeys: ["ops.directory.view"] } },
        "GET /v1/ops/directory": () => pendingDir as unknown as Response,
      });
      const { unmount: unmountDirLoading } = renderAt("#/", depsDirLoading);
      await screen.findByRole("status");
      unmountDirLoading();
      resolveDir(new Response(JSON.stringify(sampleDirectory), { status: 200 }));

      // State 9: Directory list
      const depsDirList = stubDeps({
        "GET /v1/ops/me": { status: 200, body: { roleKeys: ["ops.directory.view"] } },
        "GET /v1/ops/directory": { status: 200, body: sampleDirectory },
      });
      const { unmount: unmountDirList } = renderAt("#/", depsDirList);
      await screen.findByRole("table");
      unmountDirList();

      // State 10: Directory empty
      const depsDirEmpty = stubDeps({
        "GET /v1/ops/me": { status: 200, body: { roleKeys: ["ops.directory.view"] } },
        "GET /v1/ops/directory": { status: 200, body: { organisations: [], truncated: false } },
      });
      const { unmount: unmountDirEmpty } = renderAt("#/", depsDirEmpty);
      await screen.findByRole("heading", { level: 1, name: "Directory" });
      unmountDirEmpty();

      // State 10b: Directory truncated
      const depsDirTruncated = stubDeps({
        "GET /v1/ops/me": { status: 200, body: { roleKeys: ["ops.directory.view"] } },
        "GET /v1/ops/directory": { status: 200, body: { ...sampleDirectory, truncated: true } },
      });
      const { unmount: unmountDirTruncated } = renderAt("#/", depsDirTruncated);
      await screen.findByText(DIRECTORY_TRUNCATED_MESSAGE);
      unmountDirTruncated();

      // State 10c: Directory 403
      const depsDir403 = stubDeps({
        "GET /v1/ops/me": { status: 200, body: { roleKeys: ["ops.directory.view"] } },
        "GET /v1/ops/directory": { status: 403 },
      });
      const { unmount: unmountDir403 } = renderAt("#/", depsDir403);
      await screen.findByRole("alert");
      unmountDir403();

      // State 11: Directory failed
      const depsDirFailed = stubDeps({
        "GET /v1/ops/me": { status: 200, body: { roleKeys: ["ops.directory.view"] } },
        "GET /v1/ops/directory": { status: 500 },
      });
      const { unmount: unmountDirFailed } = renderAt("#/", depsDirFailed);
      await screen.findByRole("button", { name: TRY_AGAIN_BUTTON_LABEL });
      unmountDirFailed();

      // State 12: Error boundary after a child throws
      const containerBomb = document.createElement("div");
      document.body.appendChild(containerBomb);
      const rootBomb = createRoot(containerBomb, rootOptions);
      await act(async () => {
        rootBomb.render(
          <ErrorBoundary>
            <Bomb />
          </ErrorBoundary>,
        );
      });
      expect(containerBomb.querySelector("h1")?.textContent).toBe(
        "Something went wrong. Reload the page.",
      );
      await act(async () => {
        rootBomb.unmount();
      });
      containerBomb.remove();

      // Assert: NO style elements, NO insertRule, NO adopted sheets, NO style attributes
      expect(styleElementCalls).toHaveLength(0);
      expect(insertRuleCalls).toHaveLength(0);
      expect(adoptedStyleSheetsWrites).toHaveLength(0);
      expect(styleAttributeCalls).toHaveLength(0);
    } finally {
      createElementSpy.mockRestore();
      insertRuleSpy.mockRestore();
      setAttributeSpy.mockRestore();
      if (originalAdopted) {
        Object.defineProperty(targetObj, "adoptedStyleSheets", originalAdopted);
      } else {
        delete (targetObj as Record<string, unknown>).adoptedStyleSheets;
      }
    }
  });
});
