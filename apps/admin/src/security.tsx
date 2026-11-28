import { Alert, Button, ConfirmDialog, Field, Input, Panel } from "@community-hub/ui";
import {
  type FormEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Link } from "react-router";

import { authCall } from "./api";
import { clearAccessToken, readAccessToken } from "./directory";
import { FRESH_TEXT, FreshCheck, type FreshOutcome, useHeadingFocus } from "./fresh-check";
import { ScreenTitle } from "./screen-title";
import {
  AuthenticatorKey,
  BackupCodesScreen,
  codesLeftSentence,
  createPasskey,
  digitsOnly,
  hasWebAuthn,
  MESSAGES,
  NoticeAlert,
  qrMarkup,
  readAuthenticationOptions,
  readBackupCodes,
  readJson,
  readRegistrationOptions,
  readTotpStart,
  requestAssertion,
  TOTP_DIGITS,
  useAttempt,
} from "./second-factor";

// Settings → Security: how the signed-in person confirms it's them. It lists the authenticator app,
// the passkeys and the backup codes, and changes them behind a fresh check ("Confirm it's you"). A
// session that signed in with a backup code is in a short recovery window instead: it may set up
// again without the check, and may not remove the app. The service decides all of it; this page
// only reads what it says and shows the right choices. It never shows a TOTP key except the one a
// setup has just been given, and it never keeps a code, a key or a link anywhere but on screen.

const TEXT = {
  lastFactor: "You need at least one way to confirm it's you",
  passkeyGone: "That passkey is no longer there",
  appGone: "Your authenticator app is no longer there",
  passkeyNotSaved: "The passkey wasn't saved. Try again.",
  passkeysUnavailable: FRESH_TEXT.passkeysUnavailable,
  windowEnded: "The recovery window has ended. Sign in again to make changes.",
  recovery:
    "You signed in with a backup code. For a short time you can set up your sign-in methods again: replace your authenticator app, add or remove a passkey, or make new backup codes.",
} as const;

// A fresh factor lasts five minutes on the service.
const FRESH_WINDOW_MS = 5 * 60_000;

// ---- reading what the service answers --------------------------------------------------------

type Passkey = { id: string; createdAt: Date | null };

type Factors = {
  totp: { confirmedAt: Date } | null;
  passkeys: Passkey[];
  backupCodesLeft: number;
  // Milliseconds since the epoch, or null.
  freshUntil: number | null;
  recoveryUntil: number | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// A time the service sent, in milliseconds. Undefined when it is not a time.
function instant(value: unknown): number | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const time = Date.parse(value);
  return Number.isNaN(time) ? undefined : time;
}

// Only the fields the page uses are taken, so nothing else an answer carries, a key included, can
// reach the screen. An answer that is not what the service sends shows nothing.
function readFactors(body: unknown): Factors | undefined {
  if (!isRecord(body)) {
    return undefined;
  }
  const { totp, passkeys, backupCodesLeft, freshUntil, recoveryUntil } = body;

  let app: Factors["totp"];
  if (totp === null) {
    app = null;
  } else if (isRecord(totp)) {
    const at = instant(totp.confirmedAt);
    if (at === undefined) {
      return undefined;
    }
    app = { confirmedAt: new Date(at) };
  } else {
    return undefined;
  }

  if (!Array.isArray(passkeys)) {
    return undefined;
  }
  const keys: Passkey[] = [];
  for (const item of passkeys as unknown[]) {
    if (!isRecord(item)) {
      return undefined;
    }
    const { id, createdAt } = item;
    if (typeof id !== "string" || id === "") {
      return undefined;
    }
    if (createdAt === null) {
      keys.push({ id, createdAt: null });
      continue;
    }
    const at = instant(createdAt);
    if (at === undefined) {
      return undefined;
    }
    keys.push({ id, createdAt: new Date(at) });
  }

  if (
    typeof backupCodesLeft !== "number" ||
    !Number.isInteger(backupCodesLeft) ||
    backupCodesLeft < 0
  ) {
    return undefined;
  }

  const fresh = freshUntil === null ? null : instant(freshUntil);
  // A service that sends no recovery window has none to report.
  const recovery =
    recoveryUntil === null || recoveryUntil === undefined ? null : instant(recoveryUntil);
  if (fresh === undefined || recovery === undefined) {
    return undefined;
  }
  return {
    totp: app,
    passkeys: keys,
    backupCodesLeft,
    freshUntil: fresh,
    recoveryUntil: recovery,
  };
}

function isFuture(until: number | null): boolean {
  return until !== null && until > Date.now();
}

function dateText(date: Date): string {
  return date.toLocaleDateString();
}

// ---- what a person can ask for ---------------------------------------------------------------

type Action =
  | { kind: "setup_app" }
  | { kind: "add_passkey" }
  | { kind: "remove_app" }
  | { kind: "remove_passkey"; passkeyId: string }
  | { kind: "new_codes" };

type Step =
  | { kind: "list" }
  | { kind: "confirm"; action: Action }
  | { kind: "setup_app"; secret: string; svg: string }
  | { kind: "codes"; codes: readonly string[] };

type Phase = "loading" | "failed" | "signed_out" | "ready";

type SetupOutcome = "done" | "wrong" | "failed" | "gone";

// What asking the factor list says after the service refused a call. A refusal is an empty 401
// whether the code was wrong, the fresh check ran out, the recovery window ended or the session is
// gone, so the list is how the page tells them apart.
type Verdict = "signed_out" | "failed" | "allowed" | "needs_fresh" | "window_ended";

// ---- the screens a change goes through -------------------------------------------------------

function SetupAppStep({
  secret,
  svg,
  onConfirm,
  onCancel,
}: {
  secret: string;
  svg: string;
  onConfirm: (code: string) => Promise<SetupOutcome>;
  onCancel: () => void;
}) {
  const heading = useHeadingFocus();
  const { busy, run, notice, showNotice } = useAttempt();
  const [code, setCode] = useState("");

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    void run(async () => {
      const outcome = await onConfirm(code);
      if (outcome === "wrong") {
        setCode("");
        showNotice(MESSAGES.wrongSetupCode);
      } else if (outcome === "failed") {
        showNotice(MESSAGES.generic);
      }
    });
  }

  return (
    <Panel title="Set up an authenticator app" level={2} headingRef={heading} headingTabIndex={-1}>
      <NoticeAlert notice={notice} />
      <p className="text-sm text-foreground">
        Scan this picture with an authenticator app on your phone.
      </p>
      <AuthenticatorKey secret={secret} svg={svg} />
      <form className="grid gap-4" onSubmit={submit}>
        <Field label="Authenticator code" help="Then type the 6 digits your app shows.">
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
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </Panel>
  );
}

// ---- the page --------------------------------------------------------------------------------

export function SecurityPage() {
  const [phase, setPhase] = useState<Phase>(() =>
    readAccessToken() === null ? "signed_out" : "loading",
  );
  const [factors, setFactors] = useState<Factors | undefined>(undefined);
  const [step, setStep] = useState<Step>({ kind: "list" });
  // The removal being asked about, kept while the dialog closes so its words do not change.
  const [removal, setRemoval] = useState<Action | undefined>(undefined);
  const [removalOpen, setRemovalOpen] = useState(false);
  const [done, setDone] = useState<string | undefined>(undefined);
  const [passkeysGone, setPasskeysGone] = useState(false);
  const [windowEnded, setWindowEnded] = useState(false);
  const page = useAttempt();

  // False once the page has gone, so a late answer changes nothing.
  const alive = useRef(true);
  // Counts the factor lists asked for; only the newest is shown.
  const loads = useRef(0);
  // Leaving a screen drops whatever it was waiting for.
  const flow = useRef(0);
  const factorsRef = useRef<Factors | undefined>(undefined);
  // When a fresh check passed on this page, so the next change does not ask again at once.
  const freshHere = useRef<number | null>(null);
  // Whether this page has seen the service report a recovery window.
  const recovered = useRef(false);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const triggers = useRef(new Map<string, HTMLElement>());
  const returnTo = useRef<string | undefined>(undefined);
  const refocus = useRef(false);

  function live(mine: number): boolean {
    return alive.current && flow.current === mine;
  }

  // When a screen is left, the focus goes back to the button that opened it, or to the page heading
  // when that button is gone.
  useLayoutEffect(() => {
    if (step.kind !== "list" || !refocus.current) {
      return;
    }
    refocus.current = false;
    const trigger =
      returnTo.current === undefined ? undefined : triggers.current.get(returnTo.current);
    (trigger ?? headingRef.current)?.focus();
  }, [step]);

  function trigger(key: string) {
    return (element: HTMLElement | null) => {
      if (element === null) {
        triggers.current.delete(key);
      } else {
        triggers.current.set(key, element);
      }
    };
  }

  function toList(options: { refocus: boolean }): void {
    refocus.current = options.refocus;
    setStep({ kind: "list" });
  }

  // Shows a problem on the list, where the alert takes the focus.
  function fail(text: string): void {
    toList({ refocus: false });
    page.showNotice(text);
  }

  function endWindow(): void {
    setWindowEnded(true);
    setDone(undefined);
    toList({ refocus: false });
  }

  // ---- asking for the list ----

  async function loadFactors(): Promise<Factors | "signed_out" | "failed"> {
    const mine = ++loads.current;
    const response = await authCall("GET", "/v1/auth/second-factor");
    if (response === "unavailable") {
      return "failed";
    }
    if (response.status === 401) {
      // The session is gone. The token is no use any more, as the other screens find when the
      // service says so.
      if (alive.current) {
        clearAccessToken();
        setPhase("signed_out");
      }
      return "signed_out";
    }
    const parsed = response.status === 200 ? readFactors(await readJson(response)) : undefined;
    if (parsed === undefined) {
      return "failed";
    }
    if (alive.current && loads.current === mine) {
      factorsRef.current = parsed;
      // What the service says now replaces what this page worked out for itself.
      freshHere.current = null;
      if (parsed.recoveryUntil !== null) {
        recovered.current = true;
      }
      setFactors(parsed);
      setPhase("ready");
    }
    return parsed;
  }

  async function firstLoad(): Promise<void> {
    const result = await loadFactors();
    if (alive.current && result === "failed" && factorsRef.current === undefined) {
      setPhase("failed");
      page.showNotice(MESSAGES.generic);
    }
  }

  useEffect(() => {
    alive.current = true;
    if (readAccessToken() !== null) {
      void firstLoad();
    }
    return () => {
      alive.current = false;
    };
  }, []);

  function tryAgain(): void {
    void page.run(async () => {
      const result = await loadFactors();
      if (alive.current && result === "failed") {
        page.showNotice(MESSAGES.generic);
      }
    });
  }

  async function verdictAfterRefusal(): Promise<Verdict> {
    const model = await loadFactors();
    if (model === "signed_out" || model === "failed") {
      return model;
    }
    if (model.recoveryUntil !== null) {
      return "allowed";
    }
    if (recovered.current) {
      return "window_ended";
    }
    return isFuture(model.freshUntil) ? "allowed" : "needs_fresh";
  }

  // ---- making a change ----

  function needsFresh(model: Factors): boolean {
    // A recovery window allows these changes without the check.
    return (
      model.recoveryUntil === null && !isFuture(model.freshUntil) && !isFuture(freshHere.current)
    );
  }

  async function send(path: string, body: unknown): Promise<Response | undefined> {
    const response = await authCall("POST", path, body);
    return response === "unavailable" ? undefined : response;
  }

  async function succeeded(mine: number, text: string): Promise<void> {
    const reloaded = await loadFactors();
    if (!live(mine) || reloaded === "signed_out") {
      return;
    }
    setDone(text);
    if (reloaded === "failed") {
      fail(MESSAGES.generic);
      return;
    }
    toList({ refocus: true });
  }

  // A call the service refused. If the page had not just asked the person to confirm, it does so now
  // and tries again afterwards.
  async function refused(
    mine: number,
    action: Action,
    justConfirmed: boolean,
    whenAllowed: string,
  ): Promise<void> {
    const verdict = await verdictAfterRefusal();
    if (!live(mine)) {
      return;
    }
    if (verdict === "window_ended") {
      endWindow();
    } else if (verdict === "failed") {
      fail(MESSAGES.generic);
    } else if (verdict === "allowed") {
      fail(whenAllowed);
    } else if (verdict === "needs_fresh") {
      if (justConfirmed) {
        fail(MESSAGES.generic);
      } else {
        setStep({ kind: "confirm", action });
      }
    }
  }

  async function startApp(mine: number, justConfirmed: boolean): Promise<void> {
    const action: Action = { kind: "setup_app" };
    const response = await send("/v1/auth/second-factor/totp/start", {});
    if (!live(mine)) {
      return;
    }
    if (response === undefined) {
      fail(MESSAGES.generic);
      return;
    }
    if (response.status === 401) {
      await refused(mine, action, justConfirmed, MESSAGES.generic);
      return;
    }
    const started = response.status === 200 ? readTotpStart(await readJson(response)) : undefined;
    if (!live(mine)) {
      return;
    }
    if (started === undefined) {
      fail(MESSAGES.generic);
      return;
    }
    const svg = await qrMarkup(started.otpauthUri);
    if (!live(mine)) {
      return;
    }
    if (svg === undefined) {
      fail(MESSAGES.generic);
      return;
    }
    setStep({ kind: "setup_app", secret: started.secret, svg });
  }

  async function addPasskey(mine: number, justConfirmed: boolean): Promise<void> {
    const action: Action = { kind: "add_passkey" };
    const optionsResponse = await send("/v1/auth/passkey/register/options", {});
    if (!live(mine)) {
      return;
    }
    if (optionsResponse === undefined) {
      fail(MESSAGES.generic);
      return;
    }
    if (optionsResponse.status === 404) {
      // The service has no passkeys for the admin: stop offering them.
      setPasskeysGone(true);
      setDone(TEXT.passkeysUnavailable);
      // The button that was pressed is gone, so the focus goes to the heading.
      toList({ refocus: true });
      return;
    }
    if (optionsResponse.status === 401) {
      await refused(mine, action, justConfirmed, MESSAGES.generic);
      return;
    }
    const options =
      optionsResponse.status === 200
        ? readRegistrationOptions(await readJson(optionsResponse))
        : undefined;
    if (!live(mine)) {
      return;
    }
    if (options === undefined) {
      fail(MESSAGES.generic);
      return;
    }
    const attestation = await createPasskey(options);
    if (!live(mine)) {
      return;
    }
    if (attestation === undefined) {
      fail(TEXT.passkeyNotSaved);
      return;
    }
    const response = await send("/v1/auth/passkey/register/verify", attestation);
    if (!live(mine)) {
      return;
    }
    if (response === undefined) {
      fail(MESSAGES.generic);
    } else if (response.status === 204) {
      await succeeded(mine, "Passkey added.");
    } else if (response.status === 401) {
      // Refused, or not a passkey it could keep: the list says which.
      await refused(mine, action, justConfirmed, TEXT.passkeyNotSaved);
    } else {
      fail(TEXT.passkeyNotSaved);
    }
  }

  async function removeApp(mine: number, justConfirmed: boolean): Promise<void> {
    const action: Action = { kind: "remove_app" };
    const response = await send("/v1/auth/second-factor/totp/remove", {});
    if (!live(mine)) {
      return;
    }
    if (response === undefined) {
      fail(MESSAGES.generic);
    } else if (response.status === 204) {
      await succeeded(mine, "Authenticator app removed.");
    } else if (response.status === 401) {
      await refused(mine, action, justConfirmed, MESSAGES.generic);
    } else if (response.status === 409) {
      fail(TEXT.lastFactor);
    } else if (response.status === 404) {
      await gone(mine, TEXT.appGone);
    } else {
      fail(MESSAGES.generic);
    }
  }

  async function removePasskey(
    mine: number,
    passkeyId: string,
    justConfirmed: boolean,
  ): Promise<void> {
    const action: Action = { kind: "remove_passkey", passkeyId };
    const response = await send("/v1/auth/second-factor/passkeys/remove", { passkeyId });
    if (!live(mine)) {
      return;
    }
    if (response === undefined) {
      fail(MESSAGES.generic);
    } else if (response.status === 204) {
      await succeeded(mine, "Passkey removed.");
    } else if (response.status === 401) {
      await refused(mine, action, justConfirmed, MESSAGES.generic);
    } else if (response.status === 409) {
      fail(TEXT.lastFactor);
    } else if (response.status === 404) {
      await gone(mine, TEXT.passkeyGone);
    } else {
      fail(MESSAGES.generic);
    }
  }

  // Something to remove that is not there any more: say so, and show the list as it is now.
  async function gone(mine: number, text: string): Promise<void> {
    const reloaded = await loadFactors();
    if (!live(mine) || reloaded === "signed_out") {
      return;
    }
    fail(text);
  }

  async function newCodes(mine: number, justConfirmed: boolean): Promise<void> {
    const action: Action = { kind: "new_codes" };
    const response = await send("/v1/auth/second-factor/backup-codes", {});
    if (!live(mine)) {
      return;
    }
    if (response === undefined) {
      fail(MESSAGES.generic);
      return;
    }
    if (response.status === 401) {
      await refused(mine, action, justConfirmed, MESSAGES.generic);
      return;
    }
    const codes = response.status === 200 ? readBackupCodes(await readJson(response)) : undefined;
    if (!live(mine)) {
      return;
    }
    if (codes === undefined) {
      fail(MESSAGES.generic);
      return;
    }
    setStep({ kind: "codes", codes });
  }

  async function runAction(action: Action, justConfirmed: boolean): Promise<void> {
    const mine = flow.current;
    switch (action.kind) {
      case "setup_app":
        await startApp(mine, justConfirmed);
        break;
      case "add_passkey":
        await addPasskey(mine, justConfirmed);
        break;
      case "remove_app":
        await removeApp(mine, justConfirmed);
        break;
      case "remove_passkey":
        await removePasskey(mine, action.passkeyId, justConfirmed);
        break;
      case "new_codes":
        await newCodes(mine, justConfirmed);
        break;
    }
  }

  async function proceed(action: Action): Promise<void> {
    const model = factorsRef.current;
    if (model === undefined) {
      return;
    }
    if (needsFresh(model)) {
      setStep({ kind: "confirm", action });
      return;
    }
    await runAction(action, false);
  }

  function begin(action: Action, from: string): void {
    if (page.busy) {
      return;
    }
    returnTo.current = from;
    setDone(undefined);
    if (action.kind === "remove_app" || action.kind === "remove_passkey") {
      // Removing asks first; the check, when it is needed, comes after the answer.
      setRemoval(action);
      setRemovalOpen(true);
      return;
    }
    void page.run(() => proceed(action));
  }

  function answerRemoval(): void {
    const action = removal;
    setRemovalOpen(false);
    if (action !== undefined) {
      void page.run(() => proceed(action));
    }
  }

  function cancelStep(): void {
    flow.current += 1;
    toList({ refocus: true });
  }

  // ---- confirming it's you ----

  async function settleFresh(
    mine: number,
    response: Response | undefined,
    action: Action,
  ): Promise<FreshOutcome> {
    if (!live(mine)) {
      return "gone";
    }
    if (response === undefined) {
      return "failed";
    }
    if (response.status === 204) {
      freshHere.current = Date.now() + FRESH_WINDOW_MS;
      await runAction(action, true);
      return "passed";
    }
    if (response.status === 429) {
      return "limited";
    }
    if (response.status === 401) {
      const verdict = await verdictAfterRefusal();
      if (!live(mine) || verdict === "signed_out") {
        return "gone";
      }
      if (verdict === "window_ended") {
        endWindow();
        return "gone";
      }
      return verdict === "failed" ? "failed" : "wrong";
    }
    return "failed";
  }

  async function freshWithCode(action: Action, code: string): Promise<FreshOutcome> {
    const mine = flow.current;
    const response = await send("/v1/auth/second-factor/fresh", { code });
    return settleFresh(mine, response, action);
  }

  async function freshWithPasskey(action: Action): Promise<FreshOutcome> {
    const mine = flow.current;
    const optionsResponse = await send("/v1/auth/second-factor/fresh/passkey/options", {});
    if (!live(mine)) {
      return "gone";
    }
    if (optionsResponse === undefined) {
      return "failed";
    }
    if (optionsResponse.status === 404) {
      // The service has no passkeys for the admin: stop offering them.
      setPasskeysGone(true);
      return "unavailable";
    }
    if (optionsResponse.status !== 200) {
      return settleFresh(mine, optionsResponse, action);
    }
    const options = readAuthenticationOptions(await readJson(optionsResponse));
    if (!live(mine)) {
      return "gone";
    }
    if (options === undefined) {
      return "failed";
    }
    const assertion = await requestAssertion(options);
    if (!live(mine)) {
      return "gone";
    }
    if (assertion === undefined) {
      return "failed";
    }
    const response = await send("/v1/auth/second-factor/fresh/passkey/verify", assertion);
    return settleFresh(mine, response, action);
  }

  // ---- confirming a new app ----

  async function confirmApp(code: string): Promise<SetupOutcome> {
    const mine = flow.current;
    const response = await send("/v1/auth/second-factor/totp/confirm", { code });
    if (!live(mine)) {
      return "gone";
    }
    if (response === undefined) {
      return "failed";
    }
    if (response.status === 204) {
      await succeeded(mine, "Authenticator app set up.");
      return "done";
    }
    if (response.status === 401) {
      // A wrong code, or the fresh check ran out while the picture was open.
      const verdict = await verdictAfterRefusal();
      if (!live(mine) || verdict === "signed_out") {
        return "gone";
      }
      if (verdict === "window_ended") {
        endWindow();
        return "gone";
      }
      if (verdict === "needs_fresh") {
        setStep({ kind: "confirm", action: { kind: "setup_app" } });
        return "gone";
      }
      return verdict === "failed" ? "failed" : "wrong";
    }
    return "failed";
  }

  // ---- what is shown ----

  const heading = <ScreenTitle ref={headingRef}>Security</ScreenTitle>;

  if (phase === "signed_out") {
    return (
      <>
        {heading}
        <p>Sign in required</p>
        <Link to="/sign-in">Sign in</Link>
      </>
    );
  }

  if (phase === "loading") {
    return (
      <>
        {heading}
        <p role="status" className="text-sm text-muted-foreground">
          Loading your sign-in methods…
        </p>
      </>
    );
  }

  if (phase === "failed" || factors === undefined) {
    return (
      <>
        {heading}
        <NoticeAlert notice={page.notice} />
        <div>
          <Button type="button" disabled={page.busy} onClick={tryAgain}>
            Try again
          </Button>
        </div>
      </>
    );
  }

  let body: ReactNode;
  if (step.kind === "confirm") {
    const action = step.action;
    body = (
      <FreshCheck
        hasApp={factors.totp !== null}
        passkeyUsable={factors.passkeys.length > 0 && hasWebAuthn() && !passkeysGone}
        onCode={(code) => freshWithCode(action, code)}
        onPasskey={() => freshWithPasskey(action)}
        onCancel={cancelStep}
      />
    );
  } else if (step.kind === "setup_app") {
    body = (
      <SetupAppStep
        secret={step.secret}
        svg={step.svg}
        onConfirm={confirmApp}
        onCancel={cancelStep}
      />
    );
  } else if (step.kind === "codes") {
    body = (
      <Panel>
        <BackupCodesScreen
          codes={step.codes}
          onContinue={() => {
            void page.run(() => succeeded(flow.current, "New backup codes made."));
          }}
        />
      </Panel>
    );
  } else {
    const recovery = factors.recoveryUntil !== null;
    const canChange = !windowEnded;
    const canAddPasskey = canChange && hasWebAuthn() && !passkeysGone;
    const hasApp = factors.totp !== null;
    const left = factors.backupCodesLeft;
    body = (
      <>
        <p className="text-sm text-muted-foreground">
          Choose how you confirm it&#39;s you when you sign in.
        </p>
        {done === undefined ? null : <Alert live="polite">{done}</Alert>}
        <NoticeAlert notice={page.notice} />
        {windowEnded ? (
          <Alert variant="warning">
            {TEXT.windowEnded} <Link to="/sign-in">Sign in again</Link>
          </Alert>
        ) : recovery ? (
          <Alert variant="warning" live="polite">
            {TEXT.recovery}
          </Alert>
        ) : null}

        <Panel title="Authenticator app" level={2}>
          <p className="text-sm text-foreground">
            {factors.totp === null
              ? "Not set up."
              : `Set up on ${dateText(factors.totp.confirmedAt)}.`}
          </p>
          {canChange ? (
            <div className="flex flex-wrap gap-2">
              <Button
                ref={trigger("app")}
                type="button"
                variant={hasApp ? "outline" : "default"}
                disabled={page.busy}
                focusableWhenDisabled
                onClick={() => {
                  begin({ kind: "setup_app" }, "app");
                }}
              >
                {hasApp ? "Replace authenticator app" : "Set up an authenticator app"}
              </Button>
              {hasApp && !recovery ? (
                <Button
                  ref={trigger("app-remove")}
                  type="button"
                  variant="outline"
                  disabled={page.busy}
                  focusableWhenDisabled
                  onClick={() => {
                    begin({ kind: "remove_app" }, "app-remove");
                  }}
                >
                  Remove authenticator app
                </Button>
              ) : null}
            </div>
          ) : null}
          {hasApp && canChange ? (
            <p className="text-sm text-muted-foreground">
              A new app replaces this one when you confirm its code.
            </p>
          ) : null}
        </Panel>

        {factors.passkeys.length > 0 || canAddPasskey ? (
          <Panel title="Passkeys" level={2}>
            {factors.passkeys.length === 0 ? (
              <p className="text-sm text-foreground">No passkeys yet.</p>
            ) : (
              <ul role="list" aria-label="Your passkeys" className="grid gap-2 p-0">
                {factors.passkeys.map((key, index) => (
                  <li
                    key={key.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2"
                  >
                    <span className="text-sm text-foreground">
                      <span className="font-semibold">Passkey {index + 1}</span>
                      {" · "}
                      {key.createdAt === null
                        ? "Added on an unknown date"
                        : `Added ${dateText(key.createdAt)}`}
                    </span>
                    {canChange ? (
                      <Button
                        ref={trigger(`passkey-remove:${key.id}`)}
                        type="button"
                        variant="outline"
                        size="sm"
                        aria-label={`Remove passkey ${index + 1}`}
                        disabled={page.busy}
                        focusableWhenDisabled
                        onClick={() => {
                          begin(
                            { kind: "remove_passkey", passkeyId: key.id },
                            `passkey-remove:${key.id}`,
                          );
                        }}
                      >
                        Remove
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
            {canAddPasskey ? (
              <div>
                <Button
                  ref={trigger("passkey-add")}
                  type="button"
                  variant="outline"
                  disabled={page.busy}
                  focusableWhenDisabled
                  onClick={() => {
                    begin({ kind: "add_passkey" }, "passkey-add");
                  }}
                >
                  Add a passkey
                </Button>
              </div>
            ) : null}
          </Panel>
        ) : null}

        <Panel title="Backup codes" level={2}>
          <p className="text-sm text-foreground">Unused backup codes: {left}.</p>
          {left <= 2 ? (
            <Alert variant="warning" live="polite">
              {`${codesLeftSentence(left)} Make new ones.`}
            </Alert>
          ) : null}
          <p className="text-sm text-muted-foreground">
            A backup code is a way back in if you lose your phone or passkey. New codes make your
            old ones stop working.
          </p>
          {canChange ? (
            <div>
              <Button
                ref={trigger("codes")}
                type="button"
                variant="outline"
                disabled={page.busy}
                focusableWhenDisabled
                onClick={() => {
                  begin({ kind: "new_codes" }, "codes");
                }}
              >
                Make new backup codes
              </Button>
            </div>
          ) : null}
        </Panel>
      </>
    );
  }

  return (
    <>
      {heading}
      {body}
      <ConfirmDialog
        open={removalOpen}
        onOpenChange={(open) => {
          if (!open) {
            setRemovalOpen(false);
          }
        }}
        title={
          removal?.kind === "remove_passkey"
            ? "Remove this passkey?"
            : "Remove your authenticator app?"
        }
        description={
          removal?.kind === "remove_passkey"
            ? "You will no longer be able to use this passkey to confirm it's you."
            : "You will no longer be able to use it to confirm it's you."
        }
        confirmLabel="Remove"
        cancelLabel="Cancel"
        tone="danger"
        onConfirm={answerRemoval}
      />
    </>
  );
}
