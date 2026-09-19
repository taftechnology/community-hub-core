export type KmsContext =
  | { key_kind: "org"; org_id: string; key_version: string }
  | { key_kind: "identity"; region: string; key_version: string };

export type KmsPort = {
  generateDataKey(
    keyId: string,
    context: KmsContext,
  ): Promise<{ plaintext: Uint8Array; blob: Uint8Array }>;
  decrypt(keyId: string, blob: Uint8Array, context: KmsContext): Promise<Uint8Array>;
};
