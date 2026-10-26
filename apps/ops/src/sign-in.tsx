import { useState } from "react";
import { useNavigate } from "react-router";
import { Alert, Button } from "@community-hub/ui";

import { createApi } from "./api.js";
import { useAuthState } from "./auth-state.js";
import type { OpsDeps } from "./deps.js";
import { useFocusHeading } from "./focus.js";
import {
  ENROL_ALREADY_ACTIVE_MESSAGE,
  ENROL_COMPLETE_MESSAGE,
  GENERIC_ERROR_MESSAGE,
  SIGN_IN_BUTTON_LABEL,
  SIGN_IN_ENROL_LINK,
  SIGN_IN_NOT_ACCEPTED_MESSAGE,
} from "./messages.js";
import {
  assertionBody,
  ceremonyMessage,
  isAuthenticateOptions,
  toRequestOptions,
} from "./webauthn.js";

export type SignInProps = {
  deps: OpsDeps;
};

export function SignIn({ deps }: SignInProps) {
  const { message: carriedMessage, signedIn } = useAuthState();
  const navigate = useNavigate();
  useFocusHeading();

  const [errorMessage, setErrorMessage] = useState<string | undefined>(undefined);
  const [isPending, setIsPending] = useState(false);

  const displayMessage = errorMessage ?? carriedMessage;
  const isDefaultVariant =
    !errorMessage &&
    (carriedMessage === ENROL_COMPLETE_MESSAGE || carriedMessage === ENROL_ALREADY_ACTIVE_MESSAGE);
  const alertVariant = isDefaultVariant ? "default" : "destructive";
  const alertRole = isDefaultVariant ? "status" : "alert";

  const handleSignIn = async () => {
    if (isPending) {
      return;
    }
    setIsPending(true);
    setErrorMessage(undefined);

    const api = createApi(deps.fetch);

    try {
      const optionsRes = await api.post("/v1/ops/passkey/authenticate/options", {});
      if (
        optionsRes.kind !== "response" ||
        optionsRes.status !== 200 ||
        !isAuthenticateOptions(optionsRes.body)
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
        const reqOptions = toRequestOptions(optionsRes.body);
        credential = (await deps.credentials.get({
          publicKey: reqOptions,
        })) as PublicKeyCredential | null;
      } catch (ceremonyError) {
        setErrorMessage(ceremonyMessage(ceremonyError, "authenticate"));
        return;
      }

      if (!credential) {
        setErrorMessage(ceremonyMessage(new Error("No credential returned"), "authenticate"));
        return;
      }

      const body = assertionBody(credential);
      const verifyRes = await api.post("/v1/ops/passkey/authenticate/verify", body);

      if (verifyRes.kind === "response" && verifyRes.status === 200) {
        signedIn();
        void navigate("/");
        return;
      }

      if (verifyRes.kind === "response" && (verifyRes.status === 400 || verifyRes.status === 401)) {
        setErrorMessage(SIGN_IN_NOT_ACCEPTED_MESSAGE);
        return;
      }

      setErrorMessage(GENERIC_ERROR_MESSAGE);
    } catch {
      setErrorMessage(GENERIC_ERROR_MESSAGE);
    } finally {
      setIsPending(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <h1 tabIndex={-1} className="text-2xl font-bold tracking-tight text-foreground outline-none">
        Sign in
      </h1>
      {displayMessage && (
        <Alert role={alertRole} variant={alertVariant}>
          {displayMessage}
        </Alert>
      )}
      <div>
        <Button type="button" disabled={isPending} onClick={handleSignIn}>
          {SIGN_IN_BUTTON_LABEL}
        </Button>
      </div>
      <div>
        <a href="#/enrol" className="text-sm text-primary underline-offset-4 hover:underline">
          {SIGN_IN_ENROL_LINK}
        </a>
      </div>
    </div>
  );
}
