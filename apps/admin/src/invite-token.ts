// The invitation token lives in this module-level variable only. It is never written to
// storage, a cookie, a URL, the console or a log.
let held: string | undefined;

export function setInviteToken(token: string): void {
  held = token;
}

export function getInviteToken(): string | undefined {
  return held;
}

export function clearInviteToken(): void {
  held = undefined;
}
