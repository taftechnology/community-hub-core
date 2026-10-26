import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { Alert, Button } from "@community-hub/ui";

import { createApi } from "./api.js";
import { useAuthState } from "./auth-state.js";
import type { OpsDeps } from "./deps.js";
import { useFocusHeading } from "./focus.js";
import {
  ENROL_ALREADY_ACTIVE_MESSAGE,
  ENROL_CODE_SENT_MESSAGE,
  ENROL_COMPLETE_MESSAGE,
  ENROL_CREATE_PASSKEY_BUTTON_LABEL,
  ENROL_DIFFERENT_ADDRESS_LABEL,
  ENROL_EMAIL_CODE_LABEL,
  ENROL_EMAIL_LABEL,
  ENROL_ENROLMENT_CODE_LABEL,
  ENROL_KEEP_OPEN_MESSAGE,
  ENROL_PASSKEY_NOT_SAVED_MESSAGE,
  ENROL_SECOND_PASSKEY_MESSAGE,
  ENROL_SEND_CODE_BUTTON_LABEL,
  ENROL_SESSION_ENDED_MESSAGE,
  ENROL_STEP_1_HEADING,
  ENROL_STEP_2_HEADING,
  ENROL_STEP_3_HEADING,
  ENROL_STEP_4_HEADING,
  ENROL_VERIFY_BUTTON_LABEL,
  ENROL_WRONG_CODES_MESSAGE,
  GENERIC_ERROR_MESSAGE,
} from "./messages.js";
import {
  ceremonyMessage,
  isRegisterOptions,
  registrationBody,
  toCreationOptions,
} from "./webauthn.js";

export type EnrolProps = {
  deps: OpsDeps;
};

export function Enrol({ deps }: EnrolProps) {
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [email, setEmail] = useState("");
  const [emailCode, setEmailCode] = useState("");
  const [enrolmentCode, setEnrolmentCode] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | undefined>(undefined);
  const [isPending, setIsPending] = useState(false);

  const { signedOut } = useAuthState();
  const navigate = useNavigate();
  useFocusHeading(step);

  const handleStep1Submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (isPending) {
      return;
    }
    setIsPending(true);
    setErrorMessage(undefined);

    try {
      const api = createApi(deps.fetch);
      const res = await api.post("/v1/ops/enrolment/start", { email });
      if (res.kind === "response" && res.status === 204) {
        setStep(2);
      } else {
        setErrorMessage(GENERIC_ERROR_MESSAGE);
      }
    } catch {
      setErrorMessage(GENERIC_ERROR_MESSAGE);
    } finally {
      setIsPending(false);
    }
  };

  const handleStep2Submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (isPending) {
      return;
    }
    setIsPending(true);
    setErrorMessage(undefined);

    try {
      const api = createApi(deps.fetch);
      const cleanEmailCode = emailCode.replace(/\s+/g, "");
      const res = await api.post("/v1/ops/enrolment/verify", {
        email,
        emailCode: cleanEmailCode,
        enrolmentCode,
      });

      if (res.kind === "response" && res.status === 200) {
        const body = res.body as { status?: string } | undefined;
        if (body?.status === "enrolment") {
          setStep(3);
        } else if (body?.status === "activated") {
          signedOut(ENROL_ALREADY_ACTIVE_MESSAGE);
          void navigate("/sign-in");
        } else {
          setErrorMessage(GENERIC_ERROR_MESSAGE);
        }
      } else if (res.kind === "response" && res.status === 401) {
        setErrorMessage(ENROL_WRONG_CODES_MESSAGE);
      } else {
        setErrorMessage(GENERIC_ERROR_MESSAGE);
      }
    } catch {
      setErrorMessage(GENERIC_ERROR_MESSAGE);
    } finally {
      setIsPending(false);
    }
  };

  const handleDifferentAddress = () => {
    setEmailCode("");
    setEnrolmentCode("");
    setErrorMessage(undefined);
    setStep(1);
  };

  const handleCreatePasskey = async () => {
    if (isPending) {
      return;
    }
    setIsPending(true);
    setErrorMessage(undefined);

    try {
      const api = createApi(deps.fetch);
      const optionsRes = await api.post("/v1/ops/passkey/register/options", {});

      if (optionsRes.kind === "response" && optionsRes.status === 401) {
        setEmailCode("");
        setEnrolmentCode("");
        setStep(1);
        setErrorMessage(ENROL_SESSION_ENDED_MESSAGE);
        return;
      }

      if (
        optionsRes.kind !== "response" ||
        optionsRes.status !== 200 ||
        !isRegisterOptions(optionsRes.body)
      ) {
        setErrorMessage(GENERIC_ERROR_MESSAGE);
        return;
      }

      if (!deps.credentials) {
        setErrorMessage(GENERIC_ERROR_MESSAGE);
        return;
      }

      let credential: PublicKeyCredential | null = null;
      try {
        const creationOptions = toCreationOptions(optionsRes.body);
        credential = (await deps.credentials.create({
          publicKey: creationOptions,
        })) as PublicKeyCredential | null;
      } catch (ceremonyError) {
        setErrorMessage(ceremonyMessage(ceremonyError, "register"));
        return;
      }

      if (!credential) {
        setErrorMessage(ceremonyMessage(new Error("No credential returned"), "register"));
        return;
      }

      const body = registrationBody(credential);
      const verifyRes = await api.post("/v1/ops/passkey/register/verify", body);

      if (verifyRes.kind === "response" && verifyRes.status === 401) {
        setEmailCode("");
        setEnrolmentCode("");
        setStep(1);
        setErrorMessage(ENROL_SESSION_ENDED_MESSAGE);
        return;
      }

      if (verifyRes.kind === "response" && verifyRes.status === 400) {
        setErrorMessage(ENROL_PASSKEY_NOT_SAVED_MESSAGE);
        return;
      }

      if (verifyRes.kind === "response" && verifyRes.status === 200) {
        const verifyBody = verifyRes.body as { activated?: boolean } | undefined;
        if (verifyBody?.activated === true) {
          signedOut(ENROL_COMPLETE_MESSAGE);
          void navigate("/sign-in");
          return;
        }
        if (step === 3 && verifyBody?.activated === false) {
          setStep(4);
          setErrorMessage(undefined);
          return;
        }
      }

      setErrorMessage(GENERIC_ERROR_MESSAGE);
    } catch {
      setErrorMessage(GENERIC_ERROR_MESSAGE);
    } finally {
      setIsPending(false);
    }
  };

  if (step === 1) {
    return (
      <div className="flex flex-col gap-4">
        <h1
          tabIndex={-1}
          className="text-2xl font-bold tracking-tight text-foreground outline-none"
        >
          {ENROL_STEP_1_HEADING}
        </h1>
        <p className="text-sm text-muted-foreground">{ENROL_KEEP_OPEN_MESSAGE}</p>
        {errorMessage && (
          <Alert role="alert" variant="destructive">
            {errorMessage}
          </Alert>
        )}
        <form onSubmit={handleStep1Submit} className="flex flex-col gap-4">
          <label
            htmlFor="email"
            className="flex flex-col gap-1 text-sm font-medium text-foreground"
          >
            {ENROL_EMAIL_LABEL}
            <input
              id="email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={isPending}
              className="rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring"
            />
          </label>
          <div>
            <Button type="submit" disabled={isPending}>
              {ENROL_SEND_CODE_BUTTON_LABEL}
            </Button>
          </div>
        </form>
      </div>
    );
  }

  if (step === 2) {
    return (
      <div className="flex flex-col gap-4">
        <h1
          tabIndex={-1}
          className="text-2xl font-bold tracking-tight text-foreground outline-none"
        >
          {ENROL_STEP_2_HEADING}
        </h1>
        <p className="text-sm text-muted-foreground">{ENROL_CODE_SENT_MESSAGE}</p>
        {errorMessage && (
          <Alert role="alert" variant="destructive">
            {errorMessage}
          </Alert>
        )}
        <form onSubmit={handleStep2Submit} className="flex flex-col gap-4">
          <label
            htmlFor="email-code"
            className="flex flex-col gap-1 text-sm font-medium text-foreground"
          >
            {ENROL_EMAIL_CODE_LABEL}
            <input
              id="email-code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={emailCode}
              onChange={(e) => setEmailCode(e.target.value)}
              disabled={isPending}
              className="rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring"
            />
          </label>
          <label
            htmlFor="enrolment-code"
            className="flex flex-col gap-1 text-sm font-medium text-foreground"
          >
            {ENROL_ENROLMENT_CODE_LABEL}
            <input
              id="enrolment-code"
              type="text"
              autoComplete="off"
              spellCheck={false}
              autoCapitalize="characters"
              value={enrolmentCode}
              onChange={(e) => setEnrolmentCode(e.target.value)}
              disabled={isPending}
              className="rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring"
            />
          </label>
          <div className="flex items-center gap-3">
            <Button type="submit" disabled={isPending}>
              {ENROL_VERIFY_BUTTON_LABEL}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={isPending}
              onClick={handleDifferentAddress}
            >
              {ENROL_DIFFERENT_ADDRESS_LABEL}
            </Button>
          </div>
        </form>
      </div>
    );
  }

  if (step === 3) {
    return (
      <div className="flex flex-col gap-4">
        <h1
          tabIndex={-1}
          className="text-2xl font-bold tracking-tight text-foreground outline-none"
        >
          {ENROL_STEP_3_HEADING}
        </h1>
        {errorMessage && (
          <Alert role="alert" variant="destructive">
            {errorMessage}
          </Alert>
        )}
        <div>
          <Button type="button" disabled={isPending} onClick={handleCreatePasskey}>
            {ENROL_CREATE_PASSKEY_BUTTON_LABEL}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <h1 tabIndex={-1} className="text-2xl font-bold tracking-tight text-foreground outline-none">
        {ENROL_STEP_4_HEADING}
      </h1>
      <p className="text-sm text-muted-foreground">{ENROL_SECOND_PASSKEY_MESSAGE}</p>
      {errorMessage && (
        <Alert role="alert" variant="destructive">
          {errorMessage}
        </Alert>
      )}
      <div>
        <Button type="button" disabled={isPending} onClick={handleCreatePasskey}>
          {ENROL_CREATE_PASSKEY_BUTTON_LABEL}
        </Button>
      </div>
    </div>
  );
}
