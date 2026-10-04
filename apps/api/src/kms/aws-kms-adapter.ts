import { DecryptCommand, GenerateDataKeyCommand } from "@aws-sdk/client-kms";

import type { KmsContext } from "./context.js";
import type { BrokerKms } from "./broker-kms.js";

export function toEncryptionContext(context: KmsContext): Record<string, string> {
  if (context.key_kind === "org") {
    return {
      key_kind: "org",
      org_id: context.org_id,
      key_version: context.key_version,
    };
  }
  return {
    key_kind: "identity",
    region: context.region,
    key_version: context.key_version,
  };
}

export type KmsSendResponse = {
  Plaintext?: Uint8Array;
  CiphertextBlob?: Uint8Array;
};

export type KmsSendClient = {
  send: (
    command: GenerateDataKeyCommand | DecryptCommand,
    options?: { abortSignal?: AbortSignal },
  ) => Promise<KmsSendResponse>;
};

function zeroBytes(value: Uint8Array | undefined): void {
  if (value) {
    value.fill(0);
  }
}

function rejectIfAbortedAfterSend(
  abortSignal: AbortSignal,
  plaintext: Uint8Array,
  blob?: Uint8Array,
): void {
  if (!abortSignal.aborted) {
    return;
  }
  zeroBytes(plaintext);
  zeroBytes(blob);
  throw new Error("aborted");
}

export function createAwsBrokerKms(client: KmsSendClient): BrokerKms {
  return {
    async generateDataKey(input, opts) {
      const command = new GenerateDataKeyCommand({
        KeyId: input.keyId,
        KeySpec: "AES_256",
        EncryptionContext: toEncryptionContext(input.context),
      });
      const response = await client.send(command, { abortSignal: opts.abortSignal });
      const plaintext = response.Plaintext;
      const blob = response.CiphertextBlob;
      if (!plaintext || !blob) {
        zeroBytes(plaintext);
        zeroBytes(blob);
        throw new Error("kms response incomplete");
      }
      rejectIfAbortedAfterSend(opts.abortSignal, plaintext, blob);
      const plaintextCopy = new Uint8Array(plaintext);
      const blobCopy = new Uint8Array(blob);
      zeroBytes(plaintext);
      zeroBytes(blob);
      return { plaintext: plaintextCopy, blob: blobCopy };
    },
    async decrypt(input, opts) {
      const command = new DecryptCommand({
        KeyId: input.keyId,
        CiphertextBlob: input.blob,
        EncryptionContext: toEncryptionContext(input.context),
      });
      const response = await client.send(command, { abortSignal: opts.abortSignal });
      const plaintext = response.Plaintext;
      if (!plaintext) {
        throw new Error("kms response incomplete");
      }
      rejectIfAbortedAfterSend(opts.abortSignal, plaintext);
      const plaintextCopy = new Uint8Array(plaintext);
      zeroBytes(plaintext);
      return plaintextCopy;
    },
  };
}
