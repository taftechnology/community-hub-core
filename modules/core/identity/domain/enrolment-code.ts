const RAW_BASE32 = /^[A-Za-z2-7]+$/;
const MIN_LENGTH = 26;
const MAX_LENGTH = 128;

/**
 * Normalises an operator enrolment code:
 * - Upper-cases and removes spaces and hyphens.
 * - Refuses codes shorter than 26 or longer than 128 characters.
 * - Refuses codes with characters outside RFC 4648 base32 (A-Z, 2-7).
 * - Never strips '=' padding; input containing '=' is refused.
 */
export function normaliseEnrolmentCode(input: string): string | null {
  const stripped = input.replace(/[ -]/g, "");
  if (!RAW_BASE32.test(stripped)) {
    return null;
  }
  const uppercased = stripped.toUpperCase();
  if (uppercased.length < MIN_LENGTH || uppercased.length > MAX_LENGTH) {
    return null;
  }
  return uppercased;
}
