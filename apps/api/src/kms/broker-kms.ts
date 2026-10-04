import type { KmsContext } from "./context.js";

export type BrokerKms = {
  generateDataKey(
    input: { keyId: string; context: KmsContext },
    opts: { abortSignal: AbortSignal },
  ): Promise<{ plaintext: Uint8Array; blob: Uint8Array }>;
  decrypt(
    input: { keyId: string; blob: Uint8Array; context: KmsContext },
    opts: { abortSignal: AbortSignal },
  ): Promise<Uint8Array>;
};
