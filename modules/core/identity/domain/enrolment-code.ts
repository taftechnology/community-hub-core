const BASE32_ALPHABET = /^[A-Z2-7]+$/;
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
  const cleaned = input.toUpperCase().replace(/[\s-]/g, "");
  if (cleaned.length < MIN_LENGTH || cleaned.length > MAX_LENGTH) {
    return null;
  }
  if (!BASE32_ALPHABET.test(cleaned)) {
    return null;
  }
  return cleaned;
}
