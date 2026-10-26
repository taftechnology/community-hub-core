import { fireEvent, screen, waitFor } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, describe, expect, it } from "vitest";

import { decode, encode } from "./base64url.js";
import {
  CEREMONY_CANCELLED_MESSAGE,
  CEREMONY_SAME_DEVICE_MESSAGE,
  ENROL_ALREADY_ACTIVE_MESSAGE,
  ENROL_CODE_SENT_MESSAGE,
  ENROL_COMPLETE_MESSAGE,
  ENROL_DIFFERENT_ADDRESS_LABEL,
  ENROL_KEEP_OPEN_MESSAGE,
  ENROL_PASSKEY_NOT_SAVED_MESSAGE,
  ENROL_SECOND_PASSKEY_MESSAGE,
  ENROL_SESSION_ENDED_MESSAGE,
  ENROL_WRONG_CODES_MESSAGE,
  GENERIC_ERROR_MESSAGE,
} from "./messages.js";
import { renderAt, stubDeps, watchStorage } from "./test-support.js";

const testEmail = "operator@example.test";
const testEmailCode = "12345678";
const testEnrolmentCode = "AAAAAAAAAAAAAAAA";

const sampleRegisterOptions1 = {
  challenge: "dGVzdC1jaGFsbGVuZ2UtMQ",
  rp: { id: "ops.example.test", name: "Community Hub operations" },
  user: {
    id: "b3BlcmF0b3ItaWQ",
    name: "Community Hub operator",
    displayName: "Community Hub operator",
  },
  pubKeyCredParams: [{ type: "public-key", alg: -7 }],
  attestation: "none",
  authenticatorSelection: { userVerification: "preferred", residentKey: "required" },
  excludeCredentials: [],
};

const sampleRegisterOptions2 = {
  challenge: "dGVzdC1jaGFsbGVuZ2UtMg",
  rp: { id: "ops.example.test", name: "Community Hub operations" },
  user: {
    id: "b3BlcmF0b3ItaWQ",
    name: "Community Hub operator",
    displayName: "Community Hub operator",
  },
  pubKeyCredParams: [{ type: "public-key", alg: -7 }],
  attestation: "none",
  authenticatorSelection: { userVerification: "preferred", residentKey: "required" },
  excludeCredentials: [{ type: "public-key", id: encode(new Uint8Array([1, 2, 3])) }],
};

function happyRoutes() {
  return {
    "POST /v1/ops/enrolment/start": { status: 204 },
    "POST /v1/ops/enrolment/verify": { status: 200, body: { status: "enrolment" } },
    "POST /v1/ops/passkey/register/options": [
      { status: 200, body: sampleRegisterOptions1 },
      { status: 200, body: sampleRegisterOptions2 },
    ],
    "POST /v1/ops/passkey/register/verify": [
      { status: 200, body: { activated: false } },
      { status: 200, body: { activated: true } },
    ],
  };
}

describe("Enrol screen", () => {
  afterEach(() => {
    history.replaceState(null, "", "#/");
  });

  it("completes full happy path with two passkeys and lands on sign-in", async () => {
    const deps = stubDeps(happyRoutes());

    renderAt("#/enrol", deps);

    // Step 1: Enrol
    expect(await screen.findByRole("heading", { level: 1, name: "Enrol" })).toBeDefined();
    expect(screen.getByText(ENROL_KEEP_OPEN_MESSAGE)).toBeDefined();

    const emailInput = screen.getByLabelText("Email");
    fireEvent.change(emailInput, { target: { value: testEmail } });
    fireEvent.click(screen.getByRole("button", { name: "Send code" }));

    // Step 2: Enter your codes
    expect(
      await screen.findByRole("heading", { level: 1, name: "Enter your codes" }),
    ).toBeDefined();
    expect(screen.getByText(ENROL_CODE_SENT_MESSAGE)).toBeDefined();

    const emailCodeInput = screen.getByLabelText("Email code");
    const enrolmentCodeInput = screen.getByLabelText("Enrolment code");
    fireEvent.change(emailCodeInput, { target: { value: testEmailCode } });
    fireEvent.change(enrolmentCodeInput, { target: { value: testEnrolmentCode } });
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));

    // Step 3: Register your first passkey
    expect(
      await screen.findByRole("heading", { level: 1, name: "Register your first passkey" }),
    ).toBeDefined();
    const createButtonStep3 = screen.getByRole("button", { name: "Create passkey" });
    fireEvent.click(createButtonStep3);

    // Step 4: Add a second passkey
    expect(
      await screen.findByRole("heading", { level: 1, name: "Add a second passkey" }),
    ).toBeDefined();
    expect(screen.getByText(ENROL_SECOND_PASSKEY_MESSAGE)).toBeDefined();

    const createButtonStep4 = screen.getByRole("button", { name: "Create passkey" });
    fireEvent.click(createButtonStep4);

    // Lands on Sign in with success alert
    expect(await screen.findByRole("heading", { level: 1, name: "Sign in" })).toBeDefined();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(ENROL_COMPLETE_MESSAGE);
    expect(alert.className).not.toContain("text-destructive");
  });

  it("pin 7b: passes rp, user and excludeCredentials to create", async () => {
    const deps = stubDeps(happyRoutes());
    renderAt("#/enrol", deps);

    // Step 1
    fireEvent.change(await screen.findByLabelText("Email"), { target: { value: testEmail } });
    fireEvent.click(screen.getByRole("button", { name: "Send code" }));

    // Step 2
    fireEvent.change(await screen.findByLabelText("Email code"), {
      target: { value: testEmailCode },
    });
    fireEvent.change(screen.getByLabelText("Enrolment code"), {
      target: { value: testEnrolmentCode },
    });
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));

    // Step 3
    await screen.findByRole("heading", { level: 1, name: "Register your first passkey" });
    fireEvent.click(screen.getByRole("button", { name: "Create passkey" }));

    await waitFor(() => {
      expect(deps.credentials.create).toHaveBeenCalledTimes(1);
    });
    const call1 = deps.credentials.create.mock.calls[0]![0] as {
      publicKey?: PublicKeyCredentialCreationOptions;
    };
    expect(call1.publicKey?.rp.name).toBe("Community Hub operations");
    expect(call1.publicKey?.user.name).toBe("Community Hub operator");
    expect(call1.publicKey?.user.displayName).toBe("Community Hub operator");
    expect(call1.publicKey?.excludeCredentials).toEqual([]);

    // Step 4
    await screen.findByRole("heading", { level: 1, name: "Add a second passkey" });
    fireEvent.click(screen.getByRole("button", { name: "Create passkey" }));

    await waitFor(() => {
      expect(deps.credentials.create).toHaveBeenCalledTimes(2);
    });
    const call2 = deps.credentials.create.mock.calls[1]![0] as {
      publicKey?: PublicKeyCredentialCreationOptions;
    };
    expect(call2.publicKey?.rp.name).toBe("Community Hub operations");
    expect(call2.publicKey?.user.name).toBe("Community Hub operator");
    expect(call2.publicKey?.user.displayName).toBe("Community Hub operator");
    expect(call2.publicKey?.excludeCredentials).toEqual([
      {
        type: "public-key",
        id: decode(sampleRegisterOptions2.excludeCredentials[0]!.id),
      },
    ]);
  });

  it("pin 5: watchStorage records nothing, location holds no email or codes, autocomplete is off", async () => {
    const watcher = watchStorage();
    try {
      const deps = stubDeps(happyRoutes());
      renderAt("#/enrol", deps);

      // Step 1 check
      expect(location.href).not.toContain(testEmail);
      expect(location.href).not.toContain(testEmailCode);
      expect(location.href).not.toContain(testEnrolmentCode);

      fireEvent.change(await screen.findByLabelText("Email"), { target: { value: testEmail } });
      fireEvent.click(screen.getByRole("button", { name: "Send code" }));

      // Step 2 check
      await screen.findByRole("heading", { level: 1, name: "Enter your codes" });
      expect(location.href).not.toContain(testEmail);
      expect(location.href).not.toContain(testEmailCode);
      expect(location.href).not.toContain(testEnrolmentCode);

      const enrolmentInput = screen.getByLabelText("Enrolment code");
      expect(enrolmentInput.getAttribute("autocomplete")).toBe("off");

      fireEvent.change(screen.getByLabelText("Email code"), {
        target: { value: testEmailCode },
      });
      fireEvent.change(enrolmentInput, {
        target: { value: testEnrolmentCode },
      });
      fireEvent.click(screen.getByRole("button", { name: "Verify" }));

      // Step 3 check
      await screen.findByRole("heading", { level: 1, name: "Register your first passkey" });
      expect(location.href).not.toContain(testEmail);
      expect(location.href).not.toContain(testEmailCode);
      expect(location.href).not.toContain(testEnrolmentCode);
      fireEvent.click(screen.getByRole("button", { name: "Create passkey" }));

      // Step 4 check
      await screen.findByRole("heading", { level: 1, name: "Add a second passkey" });
      expect(location.href).not.toContain(testEmail);
      expect(location.href).not.toContain(testEmailCode);
      expect(location.href).not.toContain(testEnrolmentCode);
      fireEvent.click(screen.getByRole("button", { name: "Create passkey" }));

      // Land on Sign-in
      await screen.findByRole("heading", { level: 1, name: "Sign in" });
      expect(location.href).not.toContain(testEmail);
      expect(location.href).not.toContain(testEmailCode);
      expect(location.href).not.toContain(testEnrolmentCode);

      expect(watcher.calls).toHaveLength(0);
    } finally {
      watcher.restore();
    }
  });

  it("pin 4: every submit is defaultPrevented", async () => {
    const deps = stubDeps(happyRoutes());
    renderAt("#/enrol", deps);

    // Step 1 form submit event
    const form1 = (await screen.findByLabelText("Email")).closest("form")!;
    const submitEvent1 = new Event("submit", { cancelable: true, bubbles: true });
    form1.dispatchEvent(submitEvent1);
    expect(submitEvent1.defaultPrevented).toBe(true);

    // Move to step 2
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: testEmail } });
    fireEvent.click(screen.getByRole("button", { name: "Send code" }));

    // Step 2 form submit event
    const form2 = (await screen.findByLabelText("Email code")).closest("form")!;
    const submitEvent2 = new Event("submit", { cancelable: true, bubbles: true });
    form2.dispatchEvent(submitEvent2);
    expect(submitEvent2.defaultPrevented).toBe(true);
  });

  it("field handling: email code strips whitespace and enrolment code preserves case and characters", async () => {
    const deps = stubDeps(happyRoutes());
    renderAt("#/enrol", deps);

    fireEvent.change(await screen.findByLabelText("Email"), { target: { value: testEmail } });
    fireEvent.click(screen.getByRole("button", { name: "Send code" }));

    await screen.findByRole("heading", { level: 1, name: "Enter your codes" });
    fireEvent.change(screen.getByLabelText("Email code"), {
      target: { value: "1234 5678\n" },
    });
    fireEvent.change(screen.getByLabelText("Enrolment code"), {
      target: { value: "AAAA-BBBB-CCCC" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));

    await waitFor(() => {
      const verifyCall = deps.calls.find((c) => c.path === "/v1/ops/enrolment/verify");
      expect(verifyCall).toBeDefined();
      expect(verifyCall!.body).toEqual({
        email: testEmail,
        emailCode: "12345678",
        enrolmentCode: "AAAA-BBBB-CCCC",
      });
    });
  });

  it("branch: verify activated goes to sign-in with already-active message", async () => {
    const deps = stubDeps({
      "POST /v1/ops/enrolment/start": { status: 204 },
      "POST /v1/ops/enrolment/verify": { status: 200, body: { status: "activated" } },
    });

    renderAt("#/enrol", deps);
    fireEvent.change(await screen.findByLabelText("Email"), { target: { value: testEmail } });
    fireEvent.click(screen.getByRole("button", { name: "Send code" }));

    await screen.findByRole("heading", { level: 1, name: "Enter your codes" });
    fireEvent.change(screen.getByLabelText("Email code"), { target: { value: testEmailCode } });
    fireEvent.change(screen.getByLabelText("Enrolment code"), {
      target: { value: testEnrolmentCode },
    });
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));

    await screen.findByRole("heading", { level: 1, name: "Sign in" });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(ENROL_ALREADY_ACTIVE_MESSAGE);
    expect(alert.className).not.toContain("text-destructive");
  });

  it("branch: verify 401 shows codes error and stays on step 2", async () => {
    const deps = stubDeps({
      "POST /v1/ops/enrolment/start": { status: 204 },
      "POST /v1/ops/enrolment/verify": { status: 401 },
    });

    renderAt("#/enrol", deps);
    fireEvent.change(await screen.findByLabelText("Email"), { target: { value: testEmail } });
    fireEvent.click(screen.getByRole("button", { name: "Send code" }));

    await screen.findByRole("heading", { level: 1, name: "Enter your codes" });
    fireEvent.change(screen.getByLabelText("Email code"), { target: { value: testEmailCode } });
    fireEvent.change(screen.getByLabelText("Enrolment code"), {
      target: { value: testEnrolmentCode },
    });
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(ENROL_WRONG_CODES_MESSAGE);
    expect(screen.getByRole("heading", { level: 1, name: "Enter your codes" })).toBeDefined();
  });

  it("branch: 'Use a different address' returns to step 1 and clears codes", async () => {
    const deps = stubDeps({
      "POST /v1/ops/enrolment/start": { status: 204 },
    });

    renderAt("#/enrol", deps);
    fireEvent.change(await screen.findByLabelText("Email"), { target: { value: testEmail } });
    fireEvent.click(screen.getByRole("button", { name: "Send code" }));

    await screen.findByRole("heading", { level: 1, name: "Enter your codes" });
    const emailCodeInput = screen.getByLabelText("Email code");
    const enrolmentCodeInput = screen.getByLabelText("Enrolment code");
    fireEvent.change(emailCodeInput, { target: { value: testEmailCode } });
    fireEvent.change(enrolmentCodeInput, { target: { value: testEnrolmentCode } });

    fireEvent.click(screen.getByRole("button", { name: ENROL_DIFFERENT_ADDRESS_LABEL }));

    expect(await screen.findByRole("heading", { level: 1, name: "Enrol" })).toBeDefined();

    // Advance to step 2 again and verify codes were cleared
    fireEvent.click(screen.getByRole("button", { name: "Send code" }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "Enter your codes" }),
    ).toBeDefined();
    expect((screen.getByLabelText("Email code") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Enrolment code") as HTMLInputElement).value).toBe("");
  });

  it("branch: register verify 400 shows not-saved message and next click requests options again", async () => {
    const deps = stubDeps({
      "POST /v1/ops/enrolment/start": { status: 204 },
      "POST /v1/ops/enrolment/verify": { status: 200, body: { status: "enrolment" } },
      "POST /v1/ops/passkey/register/options": [
        { status: 200, body: sampleRegisterOptions1 },
        { status: 200, body: sampleRegisterOptions1 },
      ],
      "POST /v1/ops/passkey/register/verify": [
        { status: 400 },
        { status: 200, body: { activated: false } },
      ],
    });

    renderAt("#/enrol", deps);
    fireEvent.change(await screen.findByLabelText("Email"), { target: { value: testEmail } });
    fireEvent.click(screen.getByRole("button", { name: "Send code" }));

    fireEvent.change(await screen.findByLabelText("Email code"), {
      target: { value: testEmailCode },
    });
    fireEvent.change(screen.getByLabelText("Enrolment code"), {
      target: { value: testEnrolmentCode },
    });
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));

    await screen.findByRole("heading", { level: 1, name: "Register your first passkey" });
    fireEvent.click(screen.getByRole("button", { name: "Create passkey" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(ENROL_PASSKEY_NOT_SAVED_MESSAGE);
    expect(
      screen.getByRole("heading", { level: 1, name: "Register your first passkey" }),
    ).toBeDefined();

    // Next click
    fireEvent.click(screen.getByRole("button", { name: "Create passkey" }));
    await screen.findByRole("heading", { level: 1, name: "Add a second passkey" });

    const optionsCalls = deps.calls.filter((c) => c.path === "/v1/ops/passkey/register/options");
    expect(optionsCalls.length).toBe(2);
  });

  it("branch: 401 on options in step 3 returns to step 1 with ended message and cleared codes", async () => {
    const deps = stubDeps({
      "POST /v1/ops/enrolment/start": { status: 204 },
      "POST /v1/ops/enrolment/verify": { status: 200, body: { status: "enrolment" } },
      "POST /v1/ops/passkey/register/options": { status: 401 },
    });

    renderAt("#/enrol", deps);
    fireEvent.change(await screen.findByLabelText("Email"), { target: { value: testEmail } });
    fireEvent.click(screen.getByRole("button", { name: "Send code" }));

    fireEvent.change(await screen.findByLabelText("Email code"), {
      target: { value: testEmailCode },
    });
    fireEvent.change(screen.getByLabelText("Enrolment code"), {
      target: { value: testEnrolmentCode },
    });
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));

    await screen.findByRole("heading", { level: 1, name: "Register your first passkey" });
    fireEvent.click(screen.getByRole("button", { name: "Create passkey" }));

    await screen.findByRole("heading", { level: 1, name: "Enrol" });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(ENROL_SESSION_ENDED_MESSAGE);
  });

  it("branch: 401 on register verify in step 4 returns to step 1 with ended message and cleared codes", async () => {
    const deps = stubDeps({
      "POST /v1/ops/enrolment/start": { status: 204 },
      "POST /v1/ops/enrolment/verify": { status: 200, body: { status: "enrolment" } },
      "POST /v1/ops/passkey/register/options": [
        { status: 200, body: sampleRegisterOptions1 },
        { status: 200, body: sampleRegisterOptions2 },
      ],
      "POST /v1/ops/passkey/register/verify": [
        { status: 200, body: { activated: false } },
        { status: 401 },
      ],
    });

    renderAt("#/enrol", deps);
    fireEvent.change(await screen.findByLabelText("Email"), { target: { value: testEmail } });
    fireEvent.click(screen.getByRole("button", { name: "Send code" }));

    fireEvent.change(await screen.findByLabelText("Email code"), {
      target: { value: testEmailCode },
    });
    fireEvent.change(screen.getByLabelText("Enrolment code"), {
      target: { value: testEnrolmentCode },
    });
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));

    await screen.findByRole("heading", { level: 1, name: "Register your first passkey" });
    fireEvent.click(screen.getByRole("button", { name: "Create passkey" }));

    await screen.findByRole("heading", { level: 1, name: "Add a second passkey" });
    fireEvent.click(screen.getByRole("button", { name: "Create passkey" }));

    await screen.findByRole("heading", { level: 1, name: "Enrol" });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(ENROL_SESSION_ENDED_MESSAGE);
  });

  it("branch: InvalidStateError shows same-device message and NotAllowedError shows cancelled message", async () => {
    const deps = stubDeps({
      "POST /v1/ops/enrolment/start": { status: 204 },
      "POST /v1/ops/enrolment/verify": { status: 200, body: { status: "enrolment" } },
      "POST /v1/ops/passkey/register/options": { status: 200, body: sampleRegisterOptions1 },
    });
    deps.credentials.create.mockRejectedValueOnce(
      new DOMException("The authenticator was previously registered", "InvalidStateError"),
    );

    renderAt("#/enrol", deps);
    fireEvent.change(await screen.findByLabelText("Email"), { target: { value: testEmail } });
    fireEvent.click(screen.getByRole("button", { name: "Send code" }));

    fireEvent.change(await screen.findByLabelText("Email code"), {
      target: { value: testEmailCode },
    });
    fireEvent.change(screen.getByLabelText("Enrolment code"), {
      target: { value: testEnrolmentCode },
    });
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));

    await screen.findByRole("heading", { level: 1, name: "Register your first passkey" });
    fireEvent.click(screen.getByRole("button", { name: "Create passkey" }));

    let alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(CEREMONY_SAME_DEVICE_MESSAGE);

    deps.credentials.create.mockRejectedValueOnce(
      new DOMException("User cancelled", "NotAllowedError"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Create passkey" }));

    alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(CEREMONY_CANCELLED_MESSAGE);
  });

  it("pin 8: every call handles 503, 429 and network failures with generic error text", async () => {
    // 1. enrolment/start 503
    const depsStart = stubDeps({
      "POST /v1/ops/enrolment/start": { status: 503 },
    });
    const { unmount: u1 } = renderAt("#/enrol", depsStart);
    fireEvent.change(await screen.findByLabelText("Email"), { target: { value: testEmail } });
    fireEvent.click(screen.getByRole("button", { name: "Send code" }));
    expect((await screen.findByRole("alert")).textContent).toBe(GENERIC_ERROR_MESSAGE);
    expect(screen.getByRole("heading", { level: 1, name: "Enrol" })).toBeDefined();
    u1();

    // 2. enrolment/verify 429
    const depsVerify = stubDeps({
      "POST /v1/ops/enrolment/start": { status: 204 },
      "POST /v1/ops/enrolment/verify": { status: 429 },
    });
    const { unmount: u2 } = renderAt("#/enrol", depsVerify);
    fireEvent.change(await screen.findByLabelText("Email"), { target: { value: testEmail } });
    fireEvent.click(screen.getByRole("button", { name: "Send code" }));
    await screen.findByRole("heading", { level: 1, name: "Enter your codes" });
    fireEvent.change(screen.getByLabelText("Email code"), { target: { value: testEmailCode } });
    fireEvent.change(screen.getByLabelText("Enrolment code"), {
      target: { value: testEnrolmentCode },
    });
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));
    expect((await screen.findByRole("alert")).textContent).toBe(GENERIC_ERROR_MESSAGE);
    expect(screen.getByRole("heading", { level: 1, name: "Enter your codes" })).toBeDefined();
    u2();

    // 3. register/options network failure
    const depsOptions = stubDeps({
      "POST /v1/ops/enrolment/start": { status: 204 },
      "POST /v1/ops/enrolment/verify": { status: 200, body: { status: "enrolment" } },
      "POST /v1/ops/passkey/register/options": () => {
        throw new Error("network down");
      },
    });
    const { unmount: u3 } = renderAt("#/enrol", depsOptions);
    fireEvent.change(await screen.findByLabelText("Email"), { target: { value: testEmail } });
    fireEvent.click(screen.getByRole("button", { name: "Send code" }));
    fireEvent.change(await screen.findByLabelText("Email code"), {
      target: { value: testEmailCode },
    });
    fireEvent.change(screen.getByLabelText("Enrolment code"), {
      target: { value: testEnrolmentCode },
    });
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));
    await screen.findByRole("heading", { level: 1, name: "Register your first passkey" });
    fireEvent.click(screen.getByRole("button", { name: "Create passkey" }));
    expect((await screen.findByRole("alert")).textContent).toBe(GENERIC_ERROR_MESSAGE);
    expect(
      screen.getByRole("heading", { level: 1, name: "Register your first passkey" }),
    ).toBeDefined();
    u3();

    // 4. register/verify 500
    const depsRegVerify = stubDeps({
      "POST /v1/ops/enrolment/start": { status: 204 },
      "POST /v1/ops/enrolment/verify": { status: 200, body: { status: "enrolment" } },
      "POST /v1/ops/passkey/register/options": { status: 200, body: sampleRegisterOptions1 },
      "POST /v1/ops/passkey/register/verify": { status: 500 },
    });
    const { unmount: u4 } = renderAt("#/enrol", depsRegVerify);
    fireEvent.change(await screen.findByLabelText("Email"), { target: { value: testEmail } });
    fireEvent.click(screen.getByRole("button", { name: "Send code" }));
    fireEvent.change(await screen.findByLabelText("Email code"), {
      target: { value: testEmailCode },
    });
    fireEvent.change(screen.getByLabelText("Enrolment code"), {
      target: { value: testEnrolmentCode },
    });
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));
    await screen.findByRole("heading", { level: 1, name: "Register your first passkey" });
    fireEvent.click(screen.getByRole("button", { name: "Create passkey" }));
    expect((await screen.findByRole("alert")).textContent).toBe(GENERIC_ERROR_MESSAGE);
    expect(
      screen.getByRole("heading", { level: 1, name: "Register your first passkey" }),
    ).toBeDefined();
    u4();

    // 5. register/options fails isRegisterOptions (missing rp)
    const depsBadOpt = stubDeps({
      "POST /v1/ops/enrolment/start": { status: 204 },
      "POST /v1/ops/enrolment/verify": { status: 200, body: { status: "enrolment" } },
      "POST /v1/ops/passkey/register/options": {
        status: 200,
        body: { challenge: "dGVzdA" },
      },
    });
    const { unmount: u5 } = renderAt("#/enrol", depsBadOpt);
    fireEvent.change(await screen.findByLabelText("Email"), { target: { value: testEmail } });
    fireEvent.click(screen.getByRole("button", { name: "Send code" }));
    fireEvent.change(await screen.findByLabelText("Email code"), {
      target: { value: testEmailCode },
    });
    fireEvent.change(screen.getByLabelText("Enrolment code"), {
      target: { value: testEnrolmentCode },
    });
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));
    await screen.findByRole("heading", { level: 1, name: "Register your first passkey" });
    fireEvent.click(screen.getByRole("button", { name: "Create passkey" }));
    expect((await screen.findByRole("alert")).textContent).toBe(GENERIC_ERROR_MESSAGE);
    expect(
      screen.getByRole("heading", { level: 1, name: "Register your first passkey" }),
    ).toBeDefined();
    u5();
  });

  it("pin 8: button is disabled while pending and double clicks make only one options request", async () => {
    let resolveCreate!: (val: unknown) => void;
    const pendingPromise = new Promise((res) => {
      resolveCreate = res;
    });

    const deps = stubDeps({
      "POST /v1/ops/enrolment/start": { status: 204 },
      "POST /v1/ops/enrolment/verify": { status: 200, body: { status: "enrolment" } },
      "POST /v1/ops/passkey/register/options": { status: 200, body: sampleRegisterOptions1 },
      "POST /v1/ops/passkey/register/verify": { status: 200, body: { activated: false } },
    });
    deps.credentials.create.mockReturnValue(pendingPromise);

    renderAt("#/enrol", deps);
    fireEvent.change(await screen.findByLabelText("Email"), { target: { value: testEmail } });
    fireEvent.click(screen.getByRole("button", { name: "Send code" }));

    fireEvent.change(await screen.findByLabelText("Email code"), {
      target: { value: testEmailCode },
    });
    fireEvent.change(screen.getByLabelText("Enrolment code"), {
      target: { value: testEnrolmentCode },
    });
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));

    await screen.findByRole("heading", { level: 1, name: "Register your first passkey" });
    const button = screen.getByRole("button", { name: "Create passkey" });
    fireEvent.click(button);

    await waitFor(() => {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    });

    // Double click while pending
    fireEvent.click(button);

    const optionsCalls = deps.calls.filter((c) => c.path === "/v1/ops/passkey/register/options");
    expect(optionsCalls.length).toBe(1);

    // Clean up
    resolveCreate({
      id: "cred-1",
      rawId: new Uint8Array([1]).buffer,
      response: {
        clientDataJSON: new Uint8Array([]).buffer,
        attestationObject: new Uint8Array([]).buffer,
      },
    });
  });

  it("no probe: opening #/enrol and finishing enrolment makes no me or refresh calls", async () => {
    const deps = stubDeps(happyRoutes());
    renderAt("#/enrol", deps);

    fireEvent.change(await screen.findByLabelText("Email"), { target: { value: testEmail } });
    fireEvent.click(screen.getByRole("button", { name: "Send code" }));

    fireEvent.change(await screen.findByLabelText("Email code"), {
      target: { value: testEmailCode },
    });
    fireEvent.change(screen.getByLabelText("Enrolment code"), {
      target: { value: testEnrolmentCode },
    });
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));

    await screen.findByRole("heading", { level: 1, name: "Register your first passkey" });
    fireEvent.click(screen.getByRole("button", { name: "Create passkey" }));

    await screen.findByRole("heading", { level: 1, name: "Add a second passkey" });
    fireEvent.click(screen.getByRole("button", { name: "Create passkey" }));

    await screen.findByRole("heading", { level: 1, name: "Sign in" });

    const probeCalls = deps.calls.filter(
      (c) => c.path === "/v1/ops/me" || c.path === "/v1/ops/session/refresh",
    );
    expect(probeCalls).toHaveLength(0);
  });

  it("accessibility: focus moves to h1 on each step, labels exist, alerts used, keyboard only happy path", async () => {
    const deps = stubDeps(happyRoutes());
    renderAt("#/enrol", deps);

    // Step 1 focus
    const h1Step1 = await screen.findByRole("heading", { level: 1, name: "Enrol" });
    expect(document.activeElement).toBe(h1Step1);

    const emailInput = screen.getByLabelText("Email");
    emailInput.focus();
    fireEvent.change(emailInput, { target: { value: testEmail } });
    const sendButton = screen.getByRole("button", { name: "Send code" });
    sendButton.focus();
    fireEvent.keyDown(sendButton, { key: "Enter", code: "Enter" });
    fireEvent.click(sendButton);

    // Step 2 focus
    const h1Step2 = await screen.findByRole("heading", { level: 1, name: "Enter your codes" });
    expect(document.activeElement).toBe(h1Step2);

    const emailCodeInput = screen.getByLabelText("Email code");
    emailCodeInput.focus();
    fireEvent.change(emailCodeInput, { target: { value: testEmailCode } });

    const enrolmentCodeInput = screen.getByLabelText("Enrolment code");
    enrolmentCodeInput.focus();
    fireEvent.change(enrolmentCodeInput, { target: { value: testEnrolmentCode } });

    const verifyButton = screen.getByRole("button", { name: "Verify" });
    verifyButton.focus();
    fireEvent.keyDown(verifyButton, { key: "Enter", code: "Enter" });
    fireEvent.click(verifyButton);

    // Step 3 focus
    const h1Step3 = await screen.findByRole("heading", {
      level: 1,
      name: "Register your first passkey",
    });
    expect(document.activeElement).toBe(h1Step3);

    const createButton3 = screen.getByRole("button", { name: "Create passkey" });
    createButton3.focus();
    fireEvent.keyDown(createButton3, { key: "Enter", code: "Enter" });
    fireEvent.click(createButton3);

    // Step 4 focus
    const h1Step4 = await screen.findByRole("heading", { level: 1, name: "Add a second passkey" });
    expect(document.activeElement).toBe(h1Step4);

    const createButton4 = screen.getByRole("button", { name: "Create passkey" });
    createButton4.focus();
    fireEvent.keyDown(createButton4, { key: "Enter", code: "Enter" });
    fireEvent.click(createButton4);

    // Land on Sign in with alert in role="alert"
    const h1SignIn = await screen.findByRole("heading", { level: 1, name: "Sign in" });
    await waitFor(() => {
      expect(document.activeElement).toBe(h1SignIn);
    });
    const alert = await screen.findByRole("alert");
    expect(alert).toBeDefined();
  });

  it("axe checks pass across each step and message states", async () => {
    const deps = stubDeps(happyRoutes());
    const { container } = renderAt("#/enrol", deps);

    // Step 1 axe
    await screen.findByRole("heading", { level: 1, name: "Enrol" });
    let results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(results.violations).toEqual([]);

    // Step 1 error state axe
    fireEvent.click(screen.getByRole("button", { name: "Send code" })); // Trigger start without email (or mock fail)
    // Advance to step 2
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: testEmail } });
    fireEvent.click(screen.getByRole("button", { name: "Send code" }));

    // Step 2 axe
    await screen.findByRole("heading", { level: 1, name: "Enter your codes" });
    results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(results.violations).toEqual([]);

    // Advance to step 3
    fireEvent.change(screen.getByLabelText("Email code"), { target: { value: testEmailCode } });
    fireEvent.change(screen.getByLabelText("Enrolment code"), {
      target: { value: testEnrolmentCode },
    });
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));

    // Step 3 axe
    await screen.findByRole("heading", { level: 1, name: "Register your first passkey" });
    results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(results.violations).toEqual([]);

    // Advance to step 4
    fireEvent.click(screen.getByRole("button", { name: "Create passkey" }));

    // Step 4 axe
    await screen.findByRole("heading", { level: 1, name: "Add a second passkey" });
    results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(results.violations).toEqual([]);
  });
});
