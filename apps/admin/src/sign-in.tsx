import { Alert, Button, Field, Input } from "@community-hub/ui";
import { type FormEvent, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";

import { useCommunity } from "./community";
import { directoryOrigins, storeAccessToken, storeSignOutHandle } from "./directory";
import { getInviteToken } from "./invite-token";
import {
  hasWebAuthn,
  MESSAGES,
  NoticeAlert,
  readAdminToken,
  readAuthenticationOptions,
  readJson,
  readPreSession,
  requestAssertion,
  SecondFactorFlow,
  useNotice,
  type PreSession,
} from "./second-factor";

type Flow = { id: number; pre: PreSession };

export function SignInPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const origins = directoryOrigins();
  const { refresh } = useCommunity();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [notice, showNotice, clearNotice] = useNotice();
  // The restricted session an email code gives, and the screens that turn it into a sign-in. It
  // lives in this component's state and nowhere else: no storage, cookie, address or console.
  const [flow, setFlow] = useState<Flow | undefined>(undefined);
  const flowCount = useRef(0);
  const verifying = useRef(false);
  const [passkeyGone, setPasskeyGone] = useState(false);
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const passkeyInFlight = useRef(false);

  const searchParams = new URLSearchParams(location.search);
  const unconfirmed = searchParams.get("signout") === "unconfirmed";
  const showPasskey = !passkeyGone && hasWebAuthn();

  if (origins === undefined) {
    return <p>Directory unavailable</p>;
  }
  const authOrigin = origins.auth;

  // One JSON POST to the auth service. This page is where the sign-in network calls are made; the
  // screens that follow an email code are given this function and make none of their own.
  async function post(path: string, body: unknown, token?: string): Promise<Response | undefined> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (token !== undefined) {
      headers.authorization = `Bearer ${token}`;
    }
    try {
      return await fetch(`${authOrigin}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
    } catch {
      return undefined;
    }
  }

  // The only place the admin token is stored: after the second step, the first setup, or a
  // passkey sign-in. The pre-2FA token never comes here.
  async function finish(token: string): Promise<void> {
    storeAccessToken(token);
    storeSignOutHandle(token);
    refresh();
    // A person holding an invitation token goes to the accept screen, which is the index route.
    await navigate(getInviteToken() === undefined ? "/settings/users" : "/");
  }

  function leaveFlow(message: string | undefined): void {
    setFlow(undefined);
    setCode("");
    if (message === undefined) {
      clearNotice();
    } else {
      showNotice(message);
    }
  }

  async function sendCode(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const response = await post("/v1/auth/email-otp/start", { email });
    if (response === undefined || !response.ok) {
      showNotice(MESSAGES.failed);
    } else {
      clearNotice();
    }
  }

  async function verify(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (verifying.current) {
      return;
    }
    verifying.current = true;
    try {
      clearNotice();
      const response = await post("/v1/auth/email-otp/verify", { email, code });
      const pre = response?.status === 200 ? readPreSession(await readJson(response)) : undefined;
      if (pre === undefined) {
        showNotice(MESSAGES.failed);
        return;
      }
      flowCount.current += 1;
      setCode("");
      setFlow({ id: flowCount.current, pre });
    } finally {
      verifying.current = false;
    }
  }

  async function signInWithPasskey(): Promise<void> {
    if (passkeyInFlight.current) {
      return;
    }
    passkeyInFlight.current = true;
    setPasskeyBusy(true);
    clearNotice();
    try {
      const optionsResponse = await post("/v1/auth/passkey/authenticate/options", {});
      if (optionsResponse?.status === 404) {
        // The service has no passkeys for the admin: stop offering them.
        setPasskeyGone(true);
        showNotice(MESSAGES.passkeyUnavailable);
        return;
      }
      const options =
        optionsResponse?.status === 200
          ? readAuthenticationOptions(await readJson(optionsResponse))
          : undefined;
      const assertion = options === undefined ? undefined : await requestAssertion(options);
      if (assertion === undefined) {
        showNotice(MESSAGES.failed);
        return;
      }
      const response = await post("/v1/auth/passkey/authenticate/verify", assertion);
      const token = response?.status === 200 ? readAdminToken(await readJson(response)) : undefined;
      if (token === undefined) {
        showNotice(MESSAGES.failed);
        return;
      }
      await finish(token);
    } finally {
      passkeyInFlight.current = false;
      setPasskeyBusy(false);
    }
  }

  if (flow !== undefined) {
    return (
      <SecondFactorFlow
        key={flow.id}
        post={post}
        pre={flow.pre}
        onSignedIn={(token) => {
          void finish(token);
        }}
        onLeave={leaveFlow}
      />
    );
  }

  return (
    <>
      {unconfirmed ? (
        <Alert variant="destructive">
          We couldn&#39;t confirm you signed out. Close your browser to end the session.
        </Alert>
      ) : null}
      <NoticeAlert notice={notice} />
      <form
        className="grid gap-4"
        onSubmit={(event) => {
          void sendCode(event);
        }}
      >
        <Field label="Email">
          <Input
            type="email"
            value={email}
            onChange={(event) => {
              setEmail(event.target.value);
            }}
          />
        </Field>
        <Button className="justify-self-start" type="submit">
          Send code
        </Button>
      </form>
      <form
        className="grid gap-4"
        onSubmit={(event) => {
          void verify(event);
        }}
      >
        <Field label="Code">
          <Input
            value={code}
            onChange={(event) => {
              setCode(event.target.value);
            }}
          />
        </Field>
        <Button className="justify-self-start" type="submit">
          Verify
        </Button>
      </form>
      {showPasskey ? (
        <div className="grid gap-2 border-t border-border pt-4">
          <Button
            className="justify-self-start"
            type="button"
            variant="outline"
            disabled={passkeyBusy}
            onClick={() => {
              void signInWithPasskey();
            }}
          >
            Sign in with a passkey
          </Button>
        </div>
      ) : null}
    </>
  );
}
