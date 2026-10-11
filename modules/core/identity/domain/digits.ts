const DIGIT_LIMIT = 250;

export function digitFromByte(byte: number): string | null {
  if (byte >= DIGIT_LIMIT) {
    return null;
  }
  return String(byte % 10);
}

export function eightDigitsFrom(read: (bytes: Uint8Array) => void): string {
  const digits: string[] = [];
  const bytes = new Uint8Array(8);
  while (digits.length < 8) {
    read(bytes);
    for (const byte of bytes) {
      const digit = digitFromByte(byte);
      if (digit === null) {
        continue;
      }
      digits.push(digit);
      if (digits.length === 8) {
        break;
      }
    }
  }
  return digits.join("");
}
