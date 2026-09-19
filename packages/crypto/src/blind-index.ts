export type BlindIndex<P extends string> = Uint8Array & { readonly __blindIndex: P };

export async function blindIndex<P extends string>(
  bidxKey: CryptoKey,
  purpose: P,
  normalised: Uint8Array,
): Promise<BlindIndex<P>> {
  if (purpose.includes("\0")) {
    throw new Error("purpose must not contain NUL");
  }
  const purposeBytes = new TextEncoder().encode(purpose);
  const input = new Uint8Array(purposeBytes.byteLength + 1 + normalised.byteLength);
  input.set(purposeBytes, 0);
  input[purposeBytes.byteLength] = 0x00;
  input.set(normalised, purposeBytes.byteLength + 1);
  const mac = await crypto.subtle.sign("HMAC", bidxKey, input);
  return new Uint8Array(mac) as BlindIndex<P>;
}
