import { IdentityError } from "./error.js";

const LOCAL = /^[a-z0-9._%+-]{1,64}$/;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function normaliseEmail(input: string): string {
  const email = input.replace(/^[ ]+|[ ]+$/g, "").toLowerCase();
  const at = email.indexOf("@");
  if (at <= 0 || email.indexOf("@", at + 1) !== -1) {
    throw new IdentityError("invalid_email");
  }
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (!LOCAL.test(local) || domain.length < 1 || domain.length > 253 || !domain.includes(".")) {
    throw new IdentityError("invalid_email");
  }
  const labels = domain.split(".");
  if (labels.some((label) => !LABEL.test(label))) {
    throw new IdentityError("invalid_email");
  }
  return email;
}
