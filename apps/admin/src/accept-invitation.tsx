import { Alert, Button } from "@community-hub/ui";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";

import { post } from "./api";
import { useCommunity } from "./community";
import { readAccessToken } from "./directory";
import { clearInviteToken, getInviteToken } from "./invite-token";
import { ScreenTitle } from "./screen-title";
import { signOut } from "./sign-out";

type Phase =
  | "idle"
  | "sending"
  | "failed"
  | "accepted_no_access"
  | "wrong_address"
  | "no_longer_valid"
  | "read_only";

type Outcome =
  | { kind: "accepted"; communitySlug: string }
  | { kind: "wrong_address" }
  | { kind: "no_longer_valid" }
  | { kind: "read_only" }
  | { kind: "failed" };

async function errorCode(response: Response): Promise<string | undefined> {
  try {
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null || !("error" in body)) {
      return undefined;
    }
    return typeof body.error === "string" ? body.error : undefined;
  } catch {
    return undefined;
  }
}

async function acceptedSlug(response: Response): Promise<string | undefined> {
  try {
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null || !("communitySlug" in body)) {
      return undefined;
    }
    const slug = body.communitySlug;
    return typeof slug === "string" && slug !== "" ? slug : undefined;
  } catch {
    return undefined;
  }
}

async function readOutcome(response: Response): Promise<Outcome> {
  if (response.status === 200) {
    const communitySlug = await acceptedSlug(response);
    return communitySlug === undefined ? { kind: "failed" } : { kind: "accepted", communitySlug };
  }
  if (response.status === 402) {
    return { kind: "read_only" };
  }
  const code = await errorCode(response);
  if (response.status === 403 && code === "wrong_address") {
    return { kind: "wrong_address" };
  }
  if (
    (response.status === 404 && code === "invitation_invalid") ||
    (response.status === 409 && code === "invitation_void")
  ) {
    return { kind: "no_longer_valid" };
  }
  return { kind: "failed" };
}

export function AcceptInvitation() {
  const navigate = useNavigate();
  const { setSlug } = useCommunity();
  const [phase, setPhase] = useState<Phase>("idle");
  const inFlight = useRef(false);
  const signingOut = useRef(false);
  const alive = useRef(false);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  async function accept(): Promise<void> {
    if (inFlight.current) {
      return;
    }
    const token = getInviteToken();
    if (token === undefined) {
      return;
    }
    if (readAccessToken() === null) {
      if (alive.current) {
        setPhase("idle");
      }
      await navigate("/sign-in", { replace: true });
      return;
    }
    inFlight.current = true;
    setPhase("sending");
    try {
      const response = await post("/v1/invitations/accept", { token });
      if (response === "unavailable") {
        if (alive.current) {
          setPhase("failed");
        }
        return;
      }
      if (response.status === 401) {
        if (alive.current) {
          setPhase("idle");
        }
        await navigate("/sign-in", { replace: true });
        return;
      }
      const outcome = await readOutcome(response);
      if (outcome.kind !== "failed") {
        clearInviteToken();
      }
      if (!alive.current) {
        return;
      }
      if (outcome.kind === "failed") {
        setPhase("failed");
        return;
      }
      if (outcome.kind !== "accepted") {
        setPhase(outcome.kind);
        return;
      }
      setSlug(outcome.communitySlug);
      const capabilities = await post("/v1/access/capabilities", {
        communitySlug: outcome.communitySlug,
      });
      if (!alive.current) {
        return;
      }
      if (capabilities !== "unavailable" && capabilities.status === 403) {
        setPhase("accepted_no_access");
        return;
      }
      await navigate("/settings/users");
    } finally {
      inFlight.current = false;
    }
  }

  async function handleSignOut(): Promise<void> {
    if (signingOut.current) {
      return;
    }
    signingOut.current = true;
    try {
      await signOut();
    } finally {
      signingOut.current = false;
    }
  }

  const showAccept = phase === "idle" || phase === "sending" || phase === "failed";

  return (
    <>
      <ScreenTitle>Accept invitation</ScreenTitle>
      {phase === "failed" ? <Alert live="assertive">Something went wrong. Try again.</Alert> : null}
      {phase === "accepted_no_access" ? (
        <Alert live="polite">
          Your invitation was accepted. An administrator will give you access.
        </Alert>
      ) : null}
      {phase === "no_longer_valid" ? (
        <Alert live="assertive">This invitation is no longer valid. Ask for a new one.</Alert>
      ) : null}
      {phase === "read_only" ? (
        <Alert live="polite">
          <span>Read-only until billing is settled</span>
        </Alert>
      ) : null}
      {phase === "wrong_address" ? (
        <>
          <Alert live="assertive">
            This invitation was sent to a different address. Sign out and sign in with that address.
          </Alert>
          <Button
            type="button"
            onClick={() => {
              void handleSignOut();
            }}
          >
            Sign out
          </Button>
        </>
      ) : null}
      {showAccept ? (
        <Button
          type="button"
          disabled={phase === "sending"}
          onClick={() => {
            void accept();
          }}
        >
          Accept invitation
        </Button>
      ) : null}
    </>
  );
}
