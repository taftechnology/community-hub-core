import { Button, Field, Input, Panel } from "@community-hub/ui";
import { type FormEvent, useEffect, useLayoutEffect, useRef, useState } from "react";

import { authCall } from "./api";
import {
  digitsOnly,
  hasWebAuthn,
  MESSAGES,
  NO_PASSKEY_HERE,
  NoticeAlert,
  readAuthenticationOptions,
  readJson,
  requestAssertion,
  TOTP_DIGITS,
  useAttempt,
} from "./second-factor";

// "Confirm it's you": the panel that asks for an authenticator code or a passkey. Settings →
// Security asks it before a change to how a person signs in, and the View of a child's detail asks
// it before one field is shown. The panel only collects the answer and says how it went; the caller
// decides what a pass allows. A code or a passkey assertion goes to the service and nowhere else:
// nothing here is kept, logged or written to storage.

export type FreshOutcome = "passed" | "wrong" | "limited" | "failed" | "unavailable" | "gone";

export const FRESH_TEXT = {
  limited: "Too many tries. Try again later.",
  passkeysUnavailable: "Passkeys aren't available here.",
} as const;

const SECURITY_REASON = "Do this before you change how you confirm it's you.";

// The heading of a screen takes the focus when it opens, as the sign-in screens do.
export function useHeadingFocus() {
  const ref = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => {
    ref.current?.focus();
  }, []);
  return ref;
}

export function FreshCheck({
  hasApp,
  passkeyUsable,
  onCode,
  onPasskey,
  onCancel,
  reason = SECURITY_REASON,
  level = 2,
  loading = false,
}: {
  hasApp: boolean;
  passkeyUsable: boolean;
  onCode: (code: string) => Promise<FreshOutcome>;
  onPasskey: () => Promise<FreshOutcome>;
  onCancel: () => void;
  // The sentence under the heading, which says what the check is for.
  reason?: string;
  // The heading level of the panel on its page.
  level?: 2 | 3 | 4 | 5;
  // True while the caller is still finding out which ways this person has to confirm.
  loading?: boolean;
}) {
  const heading = useHeadingFocus();
  const { busy, run, notice, showNotice } = useAttempt();
  const [code, setCode] = useState("");

  function report(outcome: FreshOutcome): void {
    if (outcome === "wrong") {
      setCode("");
      showNotice(MESSAGES.wrongCode);
    } else if (outcome === "limited") {
      showNotice(FRESH_TEXT.limited);
    } else if (outcome === "failed") {
      showNotice(MESSAGES.generic);
    } else if (outcome === "unavailable") {
      showNotice(FRESH_TEXT.passkeysUnavailable);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    void run(async () => {
      report(await onCode(code));
    });
  }

  function startPasskey(): void {
    void run(async () => {
      report(await onPasskey());
    });
  }

  if (loading) {
    return (
      <Panel title="Confirm it's you" level={level} headingRef={heading} headingTabIndex={-1}>
        <p role="status" className="text-sm text-muted-foreground">
          Checking how you confirm it&#39;s you…
        </p>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </Panel>
    );
  }

  return (
    <Panel title="Confirm it's you" level={level} headingRef={heading} headingTabIndex={-1}>
      <NoticeAlert notice={notice} />
      <p className="text-sm text-foreground">{reason}</p>
      {hasApp ? (
        <form className="grid gap-4" onSubmit={submit}>
          <Field label="Authenticator code" help="The 6 digits your authenticator app shows.">
            <Input
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(event) => {
                setCode(digitsOnly(event.target.value));
              }}
            />
          </Field>
          <Button
            className="justify-self-start"
            type="submit"
            disabled={busy || code.length !== TOTP_DIGITS}
          >
            Confirm
          </Button>
        </form>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {passkeyUsable ? (
          <Button
            type="button"
            variant={hasApp ? "outline" : "default"}
            disabled={busy}
            onClick={startPasskey}
          >
            Use a passkey
          </Button>
        ) : null}
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      {!hasApp && !passkeyUsable ? (
        <p className="text-sm text-foreground">{NO_PASSKEY_HERE}</p>
      ) : null}
    </Panel>
  );
}

// ---- asking the service, for a screen that has no sign-in methods list of its own ---------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// Which ways this person has to confirm it's them, from the factor list. Only whether there is an
// app and whether there is a passkey is taken; nothing else the list carries is read.
function readChoices(body: unknown): { hasApp: boolean; hasPasskey: boolean } | undefined {
  if (!isRecord(body) || !Array.isArray(body.passkeys)) {
    return undefined;
  }
  if (body.totp !== null && !isRecord(body.totp)) {
    return undefined;
  }
  return { hasApp: body.totp !== null, hasPasskey: body.passkeys.length > 0 };
}

function outcomeOf(response: Response | "unavailable"): FreshOutcome {
  if (response === "unavailable") {
    return "failed";
  }
  if (response.status === 204) {
    return "passed";
  }
  if (response.status === 429) {
    return "limited";
  }
  return response.status === 401 ? "wrong" : "failed";
}

// What the panel needs on a screen that is not Settings → Security: the choices this person has,
// and the two ways to pass. The factor list is asked for once, when the panel first appears. If it
// cannot be read the panel offers an app code, and a passkey where the browser has them, and the
// service decides what is accepted.
export function useFreshCheckCalls(): {
  loading: boolean;
  hasApp: boolean;
  passkeyUsable: boolean;
  onCode: (code: string) => Promise<FreshOutcome>;
  onPasskey: () => Promise<FreshOutcome>;
} {
  const [choices, setChoices] = useState<{ hasApp: boolean; hasPasskey: boolean } | "loading">(
    "loading",
  );

  useEffect(() => {
    let live = true;
    void (async () => {
      const response = await authCall("GET", "/v1/auth/second-factor");
      const read =
        response !== "unavailable" && response.status === 200
          ? readChoices(await readJson(response))
          : undefined;
      if (live) {
        setChoices(read ?? { hasApp: true, hasPasskey: true });
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  async function onCode(code: string): Promise<FreshOutcome> {
    return outcomeOf(await authCall("POST", "/v1/auth/second-factor/fresh", { code }));
  }

  async function onPasskey(): Promise<FreshOutcome> {
    const optionsResponse = await authCall(
      "POST",
      "/v1/auth/second-factor/fresh/passkey/options",
      {},
    );
    if (optionsResponse === "unavailable") {
      return "failed";
    }
    if (optionsResponse.status === 404) {
      // The service has no passkeys for this person.
      return "unavailable";
    }
    if (optionsResponse.status !== 200) {
      return outcomeOf(optionsResponse);
    }
    const options = readAuthenticationOptions(await readJson(optionsResponse));
    if (options === undefined) {
      return "failed";
    }
    const assertion = await requestAssertion(options);
    if (assertion === undefined) {
      return "failed";
    }
    return outcomeOf(
      await authCall("POST", "/v1/auth/second-factor/fresh/passkey/verify", assertion),
    );
  }

  if (choices === "loading") {
    return { loading: true, hasApp: false, passkeyUsable: false, onCode, onPasskey };
  }
  return {
    loading: false,
    hasApp: choices.hasApp,
    passkeyUsable: choices.hasPasskey && hasWebAuthn(),
    onCode,
    onPasskey,
  };
}
