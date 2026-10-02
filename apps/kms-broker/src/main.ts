import { DecryptCommand, GenerateDataKeyCommand, KMSClient } from "@aws-sdk/client-kms";

import type { KmsContext } from "@community-hub/kms-broker";

import { assertEnvelopeKeyArn, createServer, type BrokerKms } from "./server.js";

function readEnvelopeKeyArn(): string {
  try {
    return assertEnvelopeKeyArn(process.env.ENVELOPE_KEY_ARN ?? "");
  } catch {
    process.exit(1);
  }
}

function toEncryptionContext(context: KmsContext): Record<string, string> {
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

function zeroBytes(value: Uint8Array | undefined): void {
  if (value) {
    value.fill(0);
  }
}

const envelopeKeyArn = readEnvelopeKeyArn();

const client = new KMSClient({
  region: "ap-southeast-2",
  maxAttempts: 1,
});

const kms: BrokerKms = {
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
      throw new Error("kms response incomplete");
    }
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
    const plaintextCopy = new Uint8Array(plaintext);
    zeroBytes(plaintext);
    return plaintextCopy;
  },
};

const { start } = createServer({ kms, envelopeKeyArn });

start((err) => {
  if (err) {
    process.exit(1);
  }
});
