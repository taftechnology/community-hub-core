import { Button } from "@community-hub/ui";
import { type FormEvent, useState } from "react";
import { useNavigate } from "react-router";

import { useCommunity } from "./community";
import { directoryOrigins, storeAccessToken } from "./directory";

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
  const origins = directoryOrigins();
  const { refresh } = useCommunity();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [failed, setFailed] = useState(false);

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
    refresh();
    await navigate("/settings/users");
  }

  return (
    <>
      <form
        onSubmit={(event) => {
          void sendCode(event);
        }}
      >
        <label>
          Email
          <input
            type="email"
            value={email}
            onChange={(event) => {
              setEmail(event.target.value);
            }}
          />
        </label>
        <Button type="submit">Send code</Button>
      </form>
      <form
        onSubmit={(event) => {
          void verify(event);
        }}
      >
        <label>
          Code
          <input
            value={code}
            onChange={(event) => {
              setCode(event.target.value);
            }}
          />
        </label>
        <Button type="submit">Verify</Button>
      </form>
      {failed ? <p>Sign-in failed</p> : null}
    </>
  );
}
