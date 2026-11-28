import { randomBytes } from "node:crypto";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const RAW_BASE32 = /^[A-Za-z2-7]+$/;
const BACKUP_CODE_COUNT = 10;
const BACKUP_CODE_LENGTH = 12;

/**
 * Generates ten distinct 12-character RFC 4648 base32 backup codes using randomBytes.
 */
export function newBackupCodes(): string[] {
  const codes = new Set<string>();
  while (codes.size < BACKUP_CODE_COUNT) {
    const bytes = randomBytes(BACKUP_CODE_LENGTH);
    let code = "";
    for (const byte of bytes) {
      code += BASE32_ALPHABET.charAt(byte & 0x1f);
    }
    codes.add(code);
  }
  return [...codes];
}

/**
 * Normalises a user-supplied backup code:
 * - Strips ASCII spaces and hyphens.
 * - Accepts only 12 RFC 4648 base32 characters (A-Z, 2-7, case-insensitive).
 * - Returns the upper-case 12-character code, or null if invalid.
 */
export function normaliseBackupCode(input: string): string | null {
  const stripped = input.replace(/[ -]/g, "");
  if (stripped.length !== BACKUP_CODE_LENGTH || !RAW_BASE32.test(stripped)) {
    return null;
  }
  return stripped.toUpperCase();
}

/**
 * Formats a backup code into groups of four characters separated by spaces for display.
 */
export function formatBackupCode(code: string): string {
  const normalised = normaliseBackupCode(code);
  const source = normalised ?? code;
  return source.match(/.{1,4}/g)?.join(" ") ?? "";
}
