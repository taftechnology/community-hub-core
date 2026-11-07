import { Alert, Button, Field, Input } from "@community-hub/ui";
import { type FormEvent, useState } from "react";
import { useLocation, useNavigate } from "react-router";

import { useCommunity } from "./community";
import { directoryOrigins, storeAccessToken, storeSignOutHandle } from "./directory";

async function accessToken(response: Response): Promise<string | undefined> {
  try {
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null || !("accessToken" in body)) {
      return undefined;
    }
    const token = body.accessToken;
    return typeof token === "string" ? token : undefined;
  } catch {
    return undefined;
  }
}

export function SignInPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const origins = directoryOrigins();
  const { refresh } = useCommunity();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [failed, setFailed] = useState(false);

  const searchParams = new URLSearchParams(location.search);
  const unconfirmed = searchParams.get("signout") === "unconfirmed";

  if (origins === undefined) {
    return <p>Directory unavailable</p>;
  }
  const authOrigin = origins.auth;

  async function postAuth(
    path: string,
    body: { email: string } | { email: string; code: string },
  ): Promise<Response | undefined> {
    try {
      return await fetch(`${authOrigin}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch {
      return undefined;
    }
  }

  async function sendCode(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setFailed(false);
    const response = await postAuth("/v1/auth/email-otp/start", { email });
    setFailed(response === undefined || !response.ok);
  }

  async function verify(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const response = await postAuth("/v1/auth/email-otp/verify", { email, code });
    if (response === undefined || response.status !== 200) {
      setFailed(true);
      return;
    }
    const token = await accessToken(response);
    if (token === undefined) {
      setFailed(true);
      return;
    }
    storeAccessToken(token);
    storeSignOutHandle(token);
    refresh();
    await navigate("/settings/users");
  }

  return (
    <>
      {unconfirmed ? (
        <Alert variant="destructive">
          We couldn&#39;t confirm you signed out. Close your browser to end the session.
        </Alert>
      ) : null}
      <form
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
        <Button type="submit">Send code</Button>
      </form>
      <form
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
        <Button type="submit">Verify</Button>
      </form>
      {failed ? <p>Sign-in failed</p> : null}
    </>
  );
}
