import { Alert, Button, Checkbox, Field, Input } from "@community-hub/ui";
import { toString as qrToString } from "qrcode";
import {
  type FormEvent,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

// The screens that follow a right email code: the second step, the first setup and the backup
// codes. They run inside the sign-in route, with no reload, so the invitation token held in
// invite-token.ts survives them. The pre-2FA token lives in component state only: it is never
// written to storage, a cookie, an address or the console. The admin token is handed back to the
// sign-in page, which is the only place that stores it, and only once the sign-in is complete.

export const MESSAGES = {
  failed: "Sign-in failed",
  wrongCode: "That code didn't work.",
  wrongSetupCode: "That code didn't work. Check the time on your phone and try again.",
  tooMany: "Too many tries. Sign in again.",
  generic: "Something went wrong. Try again.",
  passkeyNotSaved: "The passkey wasn't saved. Try again or use an authenticator app.",
  passkeyUnavailable: "Passkey sign-in isn't available. Use an email code.",
} as const;

const LOST_EVERYTHING =
  "Lost your phone and all your backup codes? You can't sign in until your account is recovered. Contact Community Hub support.";
const KEEP_SAFE =
  "Keep these somewhere safe. They are the only way back in if you lose your phone or passkey.";
const NO_PASSKEY_HERE = "This browser can't use passkeys. Try another browser or device.";
const COPY_FAILED = "Couldn't copy. Select the codes and copy them by hand.";

// Five answers that are not right end the pre-2FA session on the server.
const MAX_WRONG_ANSWERS = 5;
const TOTP_DIGITS = 6;
const BACKUP_CODE_LENGTH = 12;

export type SecondFactorMethod = "totp" | "passkey" | "backup_code";

// What a right email code answers: a restricted session and what it may do next.
export type PreSession = {
  token: string;
  secondFactor: "verify" | "setup";
  methods: readonly SecondFactorMethod[];
  passkeysAvailable: boolean;
};

// ---- reading what the service answers --------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

export async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

export function readPreSession(body: unknown): PreSession | undefined {
  if (!isRecord(body)) {
    return undefined;
  }
  const token = nonEmpty(body.accessToken);
  const { secondFactor, passkeysAvailable } = body;
  const listed: unknown = body.methods;
  if (
    token === undefined ||
    (secondFactor !== "verify" && secondFactor !== "setup") ||
    typeof passkeysAvailable !== "boolean" ||
    !Array.isArray(listed)
  ) {
    return undefined;
  }
  const methods: SecondFactorMethod[] = [];
  for (const method of listed as unknown[]) {
    if (method !== "totp" && method !== "passkey" && method !== "backup_code") {
      return undefined;
    }
    methods.push(method);
  }
  return { token, secondFactor, methods, passkeysAvailable };
}

export function readAdminToken(body: unknown): string | undefined {
  return isRecord(body) ? nonEmpty(body.accessToken) : undefined;
}

function readBackupCodesLeft(body: unknown): number | undefined {
  if (!isRecord(body)) {
    return undefined;
  }
  const left = body.backupCodesLeft;
  return typeof left === "number" && Number.isInteger(left) && left >= 0 ? left : undefined;
}

function readBackupCodes(body: unknown): string[] | undefined {
  if (!isRecord(body)) {
    return undefined;
  }
  const listed: unknown = body.backupCodes;
  if (!Array.isArray(listed)) {
    return undefined;
  }
  const codes: string[] = [];
  for (const item of listed as unknown[]) {
    const code = nonEmpty(item);
    if (code === undefined) {
      return undefined;
    }
    codes.push(code);
  }
  return codes.length > 0 ? codes : undefined;
}

function readTotpStart(body: unknown): { secret: string; otpauthUri: string } | undefined {
  if (!isRecord(body)) {
    return undefined;
  }
  const secret = nonEmpty(body.secret);
  const otpauthUri = nonEmpty(body.otpauthUri);
  return secret === undefined || otpauthUri === undefined ? undefined : { secret, otpauthUri };
}

// ---- talking to the auth service -------------------------------------------------------------

// One JSON POST to the auth service, bound to its origin. It answers undefined when the network
// fails. The sign-in page makes it, because that is where the admin allows a network call, and
// hands it to these screens. The token, when given, is sent as the bearer.
export type AuthPost = (
  path: string,
  body: unknown,
  token?: string,
) => Promise<Response | undefined>;

// ---- passkeys (WebAuthn) ---------------------------------------------------------------------

export function hasWebAuthn(): boolean {
  return (
    typeof PublicKeyCredential !== "undefined" &&
    typeof navigator !== "undefined" &&
    typeof navigator.credentials !== "undefined" &&
    typeof navigator.credentials.get === "function" &&
    typeof navigator.credentials.create === "function"
  );
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeBase64Url(value: unknown): Uint8Array<ArrayBuffer> | undefined {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) {
    return undefined;
  }
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  try {
    const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return undefined;
  }
}

function toBytes(value: unknown): Uint8Array | undefined {
  if (Object.prototype.toString.call(value) === "[object ArrayBuffer]") {
    return new Uint8Array(value as ArrayBuffer);
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return undefined;
}

export type AuthenticationOptions = {
  challenge: Uint8Array<ArrayBuffer>;
  rpId: string;
};

// What the browser's passkey dialog returns after a sign-in, as the service takes it.
export type Assertion = {
  credentialId: string;
  clientDataJSON: string;
  authenticatorData: string;
  signature: string;
};

type Attestation = {
  clientDataJSON: string;
  attestationObject: string;
};

export function readAuthenticationOptions(body: unknown): AuthenticationOptions | undefined {
  if (!isRecord(body)) {
    return undefined;
  }
  const challenge = decodeBase64Url(body.challenge);
  const rpId = nonEmpty(body.rpId);
  return challenge === undefined || rpId === undefined ? undefined : { challenge, rpId };
}

function readRegistrationOptions(body: unknown): PublicKeyCredentialCreationOptions | undefined {
  if (!isRecord(body) || !isRecord(body.rp) || !isRecord(body.user)) {
    return undefined;
  }
  const challenge = decodeBase64Url(body.challenge);
  const userId = decodeBase64Url(body.user.id);
  const rpId = nonEmpty(body.rp.id);
  const rpName = nonEmpty(body.rp.name);
  const { name, displayName } = body.user;
  const params: unknown = body.pubKeyCredParams;
  const excluded: unknown = body.excludeCredentials;
  if (
    challenge === undefined ||
    userId === undefined ||
    rpId === undefined ||
    rpName === undefined ||
    typeof name !== "string" ||
    typeof displayName !== "string" ||
    !Array.isArray(params) ||
    !Array.isArray(excluded)
  ) {
    return undefined;
  }
  const pubKeyCredParams: PublicKeyCredentialParameters[] = [];
  for (const item of params as unknown[]) {
    if (
      !isRecord(item) ||
      item.type !== "public-key" ||
      typeof item.alg !== "number" ||
      !Number.isInteger(item.alg)
    ) {
      return undefined;
    }
    pubKeyCredParams.push({ type: "public-key", alg: item.alg });
  }
  if (pubKeyCredParams.length === 0) {
    return undefined;
  }
  const excludeCredentials: PublicKeyCredentialDescriptor[] = [];
  for (const item of excluded as unknown[]) {
    const id = isRecord(item) && item.type === "public-key" ? decodeBase64Url(item.id) : undefined;
    if (id === undefined) {
      return undefined;
    }
    excludeCredentials.push({ type: "public-key", id });
  }
  return {
    challenge,
    rp: { id: rpId, name: rpName },
    user: { id: userId, name, displayName },
    pubKeyCredParams,
    attestation: "none",
    // A passkey here is a second factor on its own, so the device must check the person.
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
    excludeCredentials,
  };
}

function readAssertion(credential: unknown): Assertion | undefined {
  if (!isRecord(credential) || !isRecord(credential.response)) {
    return undefined;
  }
  const rawId = toBytes(credential.rawId);
  const clientDataJSON = toBytes(credential.response.clientDataJSON);
  const authenticatorData = toBytes(credential.response.authenticatorData);
  const signature = toBytes(credential.response.signature);
  if (
    rawId === undefined ||
    clientDataJSON === undefined ||
    authenticatorData === undefined ||
    signature === undefined
  ) {
    return undefined;
  }
  return {
    credentialId: encodeBase64Url(rawId),
    clientDataJSON: encodeBase64Url(clientDataJSON),
    authenticatorData: encodeBase64Url(authenticatorData),
    signature: encodeBase64Url(signature),
  };
}

function readAttestation(credential: unknown): Attestation | undefined {
  if (!isRecord(credential) || !isRecord(credential.response)) {
    return undefined;
  }
  const clientDataJSON = toBytes(credential.response.clientDataJSON);
  const attestationObject = toBytes(credential.response.attestationObject);
  if (clientDataJSON === undefined || attestationObject === undefined) {
    return undefined;
  }
  return {
    clientDataJSON: encodeBase64Url(clientDataJSON),
    attestationObject: encodeBase64Url(attestationObject),
  };
}

// Asks the browser for a passkey sign-in. Undefined when the person dismisses the dialog or the
// browser gives nothing usable.
export async function requestAssertion(
  options: AuthenticationOptions,
): Promise<Assertion | undefined> {
  try {
    const credential = await navigator.credentials.get({
      publicKey: {
        challenge: options.challenge,
        rpId: options.rpId,
        userVerification: "required",
      },
    });
    return readAssertion(credential);
  } catch {
    return undefined;
  }
}

async function createPasskey(
  options: PublicKeyCredentialCreationOptions,
): Promise<Attestation | undefined> {
  try {
    const credential = await navigator.credentials.create({ publicKey: options });
    return readAttestation(credential);
  } catch {
    return undefined;
  }
}

// ---- what is typed and shown -----------------------------------------------------------------

function inGroupsOfFour(value: string): string {
  return (value.replace(/\s+/g, "").match(/.{1,4}/g) ?? []).join(" ");
}

function digitsOnly(value: string): string {
  return value.replace(/\D/g, "").slice(0, TOTP_DIGITS);
}

// Any case, spaces and dashes are fine; only the base32 alphabet is kept.
function backupCodeFrom(value: string): string {
  return value
    .toUpperCase()
    .replace(/[^A-Z2-7]/g, "")
    .slice(0, BACKUP_CODE_LENGTH);
}

function codesLeftSentence(left: number): string {
  if (left === 0) {
    return "You have no backup codes left.";
  }
  return `You have ${left} backup ${left === 1 ? "code" : "codes"} left.`;
}

// ---- shared pieces ---------------------------------------------------------------------------

type Notice = { id: number; text: string };

export function useNotice(): [Notice | undefined, (text: string) => void, () => void] {
  const [notice, setNotice] = useState<Notice | undefined>(undefined);
  const counter = useRef(0);
  function show(text: string): void {
    counter.current += 1;
    setNotice({ id: counter.current, text });
  }
  function clear(): void {
    setNotice(undefined);
  }
  return [notice, show, clear];
}

// An error that screen readers announce and that takes focus, as the other admin screens do. A new
// notice replaces the old one, so the same message said twice is announced twice.
export function NoticeAlert({ notice }: { notice: Notice | undefined }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    ref.current?.focus();
  }, [notice]);
  if (notice === undefined) {
    return null;
  }
  return (
    <Alert key={notice.id} ref={ref} tabIndex={-1} variant="destructive" role="alert">
      {notice.text}
    </Alert>
  );
}

function StepHeading({ children }: { children: string }) {
  const ref = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <h2
      ref={ref}
      tabIndex={-1}
      className="text-[18px] leading-[24px] font-semibold text-foreground"
    >
      {children}
    </h2>
  );
}

// One request at a time on a screen: the buttons are disabled while it waits, and a second submit
// is ignored, so a code is never sent twice by one tap.
function useAttempt() {
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [notice, showNotice, clearNotice] = useNotice();
  async function run(task: () => Promise<void>): Promise<void> {
    if (inFlight.current) {
      return;
    }
    inFlight.current = true;
    setBusy(true);
    clearNotice();
    try {
      await task();
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  return { busy, run, notice, showNotice };
}

type Context = {
  post: AuthPost;
  // The pre-2FA token. In memory only.
  token: string;
  // False once the person has left, so a late answer changes nothing.
  alive: RefObject<boolean>;
  cancel: () => void;
  signedIn: (token: string) => void;
  leave: (message: string | undefined) => void;
};

// ---- the second step -------------------------------------------------------------------------

type Mode = "totp" | "backup" | "choose";

type Offers = { totp: boolean; backup: boolean; passkey: boolean };

function firstMode(offers: Offers): Mode {
  if (offers.totp) {
    return "totp";
  }
  if (offers.passkey) {
    return "choose";
  }
  return offers.backup ? "backup" : "choose";
}

function SecondStepScreen({
  context,
  pre,
  passkeyUsable,
  onBackupCodeUsed,
}: {
  context: Context;
  pre: PreSession;
  passkeyUsable: boolean;
  onBackupCodeUsed: (token: string, left: number) => void;
}) {
  const offers: Offers = {
    totp: pre.methods.includes("totp"),
    backup: pre.methods.includes("backup_code"),
    passkey: passkeyUsable,
  };
  const [mode, setMode] = useState<Mode>(() => firstMode(offers));
  const [totp, setTotp] = useState("");
  const [backup, setBackup] = useState("");
  const { busy, run, notice, showNotice } = useAttempt();
  const wrong = useRef(0);
  const field = useRef<HTMLInputElement>(null);
  const shownMode = useRef(mode);

  // The heading takes focus when the screen opens. Changing the method moves focus to its field.
  useEffect(() => {
    if (shownMode.current !== mode) {
      shownMode.current = mode;
      field.current?.focus();
    }
  }, [mode]);

  async function settle(response: Response | undefined, method: SecondFactorMethod): Promise<void> {
    if (!context.alive.current) {
      return;
    }
    if (response === undefined) {
      showNotice(MESSAGES.generic);
      return;
    }
    if (response.status === 200) {
      const body = await readJson(response);
      const token = readAdminToken(body);
      if (!context.alive.current) {
        return;
      }
      if (token === undefined) {
        showNotice(MESSAGES.generic);
        return;
      }
      const left = readBackupCodesLeft(body);
      if (method === "backup_code" && left !== undefined) {
        onBackupCodeUsed(token, left);
        return;
      }
      context.signedIn(token);
      return;
    }
    if (response.status === 429) {
      context.leave(MESSAGES.tooMany);
      return;
    }
    if (response.status === 401) {
      wrong.current += 1;
      if (wrong.current >= MAX_WRONG_ANSWERS) {
        context.leave(MESSAGES.tooMany);
        return;
      }
      setTotp("");
      setBackup("");
      showNotice(MESSAGES.wrongCode);
      return;
    }
    showNotice(MESSAGES.generic);
  }

  function submitCode(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const method = mode === "backup" ? "backup_code" : "totp";
    const code = mode === "backup" ? backup : totp;
    void run(async () => {
      const response = await context.post(
        "/v1/auth/second-factor/verify",
        { method, code },
        context.token,
      );
      await settle(response, method);
    });
  }

  function startPasskey(): void {
    void run(async () => {
      const optionsResponse = await context.post(
        "/v1/auth/second-factor/passkey/options",
        {},
        context.token,
      );
      const options =
        optionsResponse?.status === 200
          ? readAuthenticationOptions(await readJson(optionsResponse))
          : undefined;
      if (!context.alive.current) {
        return;
      }
      if (options === undefined) {
        showNotice(MESSAGES.generic);
        return;
      }
      const assertion = await requestAssertion(options);
      if (!context.alive.current) {
        return;
      }
      if (assertion === undefined) {
        showNotice(MESSAGES.generic);
        return;
      }
      const response = await context.post(
        "/v1/auth/second-factor/passkey/verify",
        assertion,
        context.token,
      );
      await settle(response, "passkey");
    });
  }

  const nothingToUse =
    pre.methods.includes("passkey") && !offers.passkey && !offers.totp && !offers.backup;

  return (
    <div className="grid gap-4">
      <StepHeading>Confirm it&#39;s you</StepHeading>
      <NoticeAlert notice={notice} />
      {mode === "totp" ? (
        <form className="grid gap-4" onSubmit={submitCode}>
          <Field label="Authenticator code" help="The 6 digits your authenticator app shows.">
            <Input
              ref={field}
              inputMode="numeric"
              autoComplete="one-time-code"
              value={totp}
              onChange={(event) => {
                setTotp(digitsOnly(event.target.value));
              }}
            />
          </Field>
          <Button
            className="justify-self-start"
            type="submit"
            disabled={busy || totp.length !== TOTP_DIGITS}
          >
            Confirm
          </Button>
        </form>
      ) : null}
      {mode === "backup" ? (
        <form className="grid gap-4" onSubmit={submitCode}>
          <Field
            label="Backup code"
            help="One of the 12-character codes you saved. Each works once."
          >
            <Input
              ref={field}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              value={inGroupsOfFour(backup)}
              onChange={(event) => {
                setBackup(backupCodeFrom(event.target.value));
              }}
            />
          </Field>
          <Button
            className="justify-self-start"
            type="submit"
            disabled={busy || backup.length !== BACKUP_CODE_LENGTH}
          >
            Confirm
          </Button>
        </form>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {mode !== "totp" && offers.totp ? (
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setMode("totp");
            }}
          >
            Use an authenticator code
          </Button>
        ) : null}
        {offers.passkey ? (
          <Button
            type="button"
            variant={mode === "choose" ? "default" : "outline"}
            disabled={busy}
            onClick={startPasskey}
          >
            Use a passkey
          </Button>
        ) : null}
        {mode !== "backup" && offers.backup ? (
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setMode("backup");
            }}
          >
            Use a backup code
          </Button>
        ) : null}
        <Button type="button" variant="ghost" onClick={context.cancel}>
          Cancel
        </Button>
      </div>
      {nothingToUse ? <p className="text-sm text-foreground">{NO_PASSKEY_HERE}</p> : null}
      <p className="text-sm text-muted-foreground">{LOST_EVERYTHING}</p>
    </div>
  );
}

function BackupCodeUsedScreen({ left, onContinue }: { left: number; onContinue: () => void }) {
  return (
    <div className="grid gap-4">
      <StepHeading>You used a backup code</StepHeading>
      <p className="text-sm text-foreground">{codesLeftSentence(left)}</p>
      <Button className="justify-self-start" type="button" onClick={onContinue}>
        Continue
      </Button>
    </div>
  );
}

// ---- the first setup -------------------------------------------------------------------------

function SetupChooseScreen({
  context,
  passkeyUsable,
  onApp,
  onCodes,
}: {
  context: Context;
  passkeyUsable: boolean;
  onApp: (secret: string, svg: string) => void;
  onCodes: (token: string, codes: readonly string[]) => void;
}) {
  const { busy, run, notice, showNotice } = useAttempt();

  function chooseApp(): void {
    void run(async () => {
      const response = await context.post("/v1/auth/second-factor/totp/start", {}, context.token);
      const started =
        response?.status === 200 ? readTotpStart(await readJson(response)) : undefined;
      if (!context.alive.current) {
        return;
      }
      if (started === undefined) {
        showNotice(MESSAGES.generic);
        return;
      }
      // The picture is inline SVG markup. The page's security policy allows no data: images.
      let svg: string;
      try {
        svg = await qrToString(started.otpauthUri, { type: "svg" });
      } catch {
        showNotice(MESSAGES.generic);
        return;
      }
      if (!context.alive.current) {
        return;
      }
      onApp(started.secret, svg);
    });
  }

  function choosePasskey(): void {
    void run(async () => {
      const optionsResponse = await context.post(
        "/v1/auth/passkey/register/options",
        {},
        context.token,
      );
      const options =
        optionsResponse?.status === 200
          ? readRegistrationOptions(await readJson(optionsResponse))
          : undefined;
      if (!context.alive.current) {
        return;
      }
      if (options === undefined) {
        showNotice(MESSAGES.generic);
        return;
      }
      const attestation = await createPasskey(options);
      if (!context.alive.current) {
        return;
      }
      if (attestation === undefined) {
        showNotice(MESSAGES.passkeyNotSaved);
        return;
      }
      const response = await context.post(
        "/v1/auth/passkey/register/verify",
        attestation,
        context.token,
      );
      if (!context.alive.current) {
        return;
      }
      if (response === undefined) {
        showNotice(MESSAGES.generic);
        return;
      }
      const body = response.status === 200 ? await readJson(response) : undefined;
      const token = readAdminToken(body);
      const codes = readBackupCodes(body);
      if (!context.alive.current) {
        return;
      }
      if (token === undefined || codes === undefined) {
        showNotice(response.status === 200 ? MESSAGES.generic : MESSAGES.passkeyNotSaved);
        return;
      }
      onCodes(token, codes);
    });
  }

  return (
    <div className="grid gap-4">
      <StepHeading>Set up two-step sign-in</StepHeading>
      <NoticeAlert notice={notice} />
      <p className="text-sm text-foreground">
        Everyone who signs in here confirms it&#39;s them a second way. Choose how you want to do
        that.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button type="button" disabled={busy} onClick={chooseApp}>
          Use an authenticator app
        </Button>
        {passkeyUsable ? (
          <Button type="button" variant="outline" disabled={busy} onClick={choosePasskey}>
            Use a passkey
          </Button>
        ) : null}
        <Button type="button" variant="ghost" onClick={context.cancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function SetupAppScreen({
  context,
  secret,
  svg,
  onBack,
  onCodes,
}: {
  context: Context;
  secret: string;
  svg: string;
  onBack: () => void;
  onCodes: (token: string, codes: readonly string[]) => void;
}) {
  const { busy, run, notice, showNotice } = useAttempt();
  const [code, setCode] = useState("");

  function confirm(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    void run(async () => {
      const response = await context.post(
        "/v1/auth/second-factor/totp/confirm",
        { code },
        context.token,
      );
      if (!context.alive.current) {
        return;
      }
      if (response === undefined) {
        showNotice(MESSAGES.generic);
        return;
      }
      if (response.status === 401) {
        setCode("");
        showNotice(MESSAGES.wrongSetupCode);
        return;
      }
      const body = response.status === 200 ? await readJson(response) : undefined;
      const token = readAdminToken(body);
      const codes = readBackupCodes(body);
      if (!context.alive.current) {
        return;
      }
      if (token === undefined || codes === undefined) {
        showNotice(MESSAGES.generic);
        return;
      }
      onCodes(token, codes);
    });
  }

  return (
    <div className="grid gap-4">
      <StepHeading>Set up an authenticator app</StepHeading>
      <NoticeAlert notice={notice} />
      <p className="text-sm text-foreground">
        Scan this picture with an authenticator app on your phone.
      </p>
      <div
        role="img"
        aria-label="QR code for your authenticator app"
        className="mx-auto size-[224px] max-w-full [&>svg]:size-full"
        dangerouslySetInnerHTML={{ __html: svg }}
      />
      <p className="text-sm text-foreground">
        Can&#39;t scan it? Type this key into your app instead.
      </p>
      <p className="rounded-md bg-muted px-3 py-2 font-mono text-sm tracking-wider break-all select-all text-foreground">
        {inGroupsOfFour(secret)}
      </p>
      <form className="grid gap-4" onSubmit={confirm}>
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
        <Button type="button" variant="outline" onClick={onBack}>
          Back
        </Button>
        <Button type="button" variant="ghost" onClick={context.cancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

// The admin session already exists on the server, but nothing is stored and nothing is entered
// until the person says the codes are saved. There is no Cancel here: the way out is Continue.
function BackupCodesScreen({
  codes,
  onContinue,
}: {
  codes: readonly string[];
  onContinue: () => void;
}) {
  const [saved, setSaved] = useState(false);
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");

  async function copyCodes(): Promise<void> {
    try {
      await navigator.clipboard.writeText(codes.map(inGroupsOfFour).join("\n"));
      setCopy("copied");
    } catch {
      setCopy("failed");
    }
  }

  let copyStatus = "";
  if (copy === "copied") {
    copyStatus = "Copied";
  } else if (copy === "failed") {
    copyStatus = COPY_FAILED;
  }

  return (
    <div className="grid gap-4">
      <StepHeading>Save your backup codes</StepHeading>
      <p className="text-sm text-foreground">{KEEP_SAFE}</p>
      <ul role="list" className="grid grid-cols-2 gap-2 p-0">
        {codes.map((code, index) => (
          <li
            key={index}
            className="rounded-md border border-border bg-muted px-2 py-2 text-center font-mono text-[13px] text-foreground"
          >
            {inGroupsOfFour(code)}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            void copyCodes();
          }}
        >
          Copy
        </Button>
        <p role="status" className="text-sm text-muted-foreground">
          {copyStatus}
        </p>
      </div>
      <Checkbox
        label="I have saved these codes"
        checked={saved}
        onChange={(event) => {
          setSaved(event.target.checked);
        }}
      />
      <Button className="justify-self-start" type="button" disabled={!saved} onClick={onContinue}>
        Continue
      </Button>
    </div>
  );
}

// ---- the flow --------------------------------------------------------------------------------

type Screen =
  | { kind: "second_step" }
  | { kind: "backup_code_used"; token: string; left: number }
  | { kind: "setup_choose" }
  | { kind: "setup_app"; secret: string; svg: string }
  | { kind: "backup_codes"; token: string; codes: readonly string[] };

export function SecondFactorFlow({
  post,
  pre,
  onSignedIn,
  onLeave,
}: {
  post: AuthPost;
  pre: PreSession;
  // Called with the admin token once the sign-in is complete. The caller stores it.
  onSignedIn: (token: string) => void;
  // Back to the email step, with a message when there is one to give.
  onLeave: (message: string | undefined) => void;
}) {
  const [screen, setScreen] = useState<Screen>({
    kind: pre.secondFactor === "verify" ? "second_step" : "setup_choose",
  });
  const alive = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const passkeyUsable = pre.passkeysAvailable && pre.methods.includes("passkey") && hasWebAuthn();

  // Ends the pre-2FA session on the server, then goes back to the email step. The person does not
  // wait for the answer, and nothing about the answer changes what they see.
  function cancel(): void {
    void post("/v1/auth/session/end", {}, pre.token);
    onLeave(undefined);
  }

  const context: Context = {
    post,
    token: pre.token,
    alive,
    cancel,
    signedIn: onSignedIn,
    leave: onLeave,
  };

  switch (screen.kind) {
    case "second_step":
      return (
        <SecondStepScreen
          context={context}
          pre={pre}
          passkeyUsable={passkeyUsable}
          onBackupCodeUsed={(token, left) => {
            setScreen({ kind: "backup_code_used", token, left });
          }}
        />
      );
    case "backup_code_used":
      return (
        <BackupCodeUsedScreen
          left={screen.left}
          onContinue={() => {
            onSignedIn(screen.token);
          }}
        />
      );
    case "setup_choose":
      return (
        <SetupChooseScreen
          context={context}
          passkeyUsable={passkeyUsable}
          onApp={(secret, svg) => {
            setScreen({ kind: "setup_app", secret, svg });
          }}
          onCodes={(token, codes) => {
            setScreen({ kind: "backup_codes", token, codes });
          }}
        />
      );
    case "setup_app":
      return (
        <SetupAppScreen
          context={context}
          secret={screen.secret}
          svg={screen.svg}
          onBack={() => {
            setScreen({ kind: "setup_choose" });
          }}
          onCodes={(token, codes) => {
            setScreen({ kind: "backup_codes", token, codes });
          }}
        />
      );
    case "backup_codes":
      return (
        <BackupCodesScreen
          codes={screen.codes}
          onContinue={() => {
            onSignedIn(screen.token);
          }}
        />
      );
  }
}
