import { DecryptCommand, GenerateDataKeyCommand } from "@aws-sdk/client-kms";
import type { KmsContext, KmsPort } from "@community-hub/crypto";

import { checkContext, ContextRejected } from "./context.js";

export const DEFAULT_DEADLINE_MS = 3000;

type Operation = "generate_data_key" | "decrypt";
type Outcome = "ok" | "rejected" | "failed" | "timeout";
type KeyKind = "org" | "identity";

type InfoFields = {
  operation: Operation;
  key_kind?: KeyKind;
  outcome: Outcome;
};

type KmsSendResponse = {
  Plaintext?: Uint8Array;
  CiphertextBlob?: Uint8Array;
};

export function createAwsKmsPort(options: {
  client: {
    send: (
      command: GenerateDataKeyCommand | DecryptCommand,
      options?: { abortSignal?: AbortSignal },
    ) => Promise<KmsSendResponse>;
  };
  keyArn: string;
  deadlineMs?: number;
  info: (fields: InfoFields) => void;
}): KmsPort {
  const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;

  function knownKind(context: unknown): KeyKind | undefined {
    if (context === null || typeof context !== "object" || !("key_kind" in context)) {
      return undefined;
    }
    const kind = context.key_kind;
    if (kind === "org" || kind === "identity") {
      return kind;
    }
    return undefined;
  }

  function report(operation: Operation, outcome: Outcome, keyKind: KeyKind | undefined): void {
    if (keyKind === undefined) {
      options.info({ operation, outcome });
      return;
    }
    options.info({ operation, outcome, key_kind: keyKind });
  }

  function failed(): Error {
    const error = new Error("kms_failed");
    return error;
  }

  function zero(value: Uint8Array | undefined): void {
    value?.fill(0);
  }

  async function prepare(
    operation: Operation,
    keyId: string,
    context: KmsContext,
  ): Promise<KmsContext> {
    const kind = knownKind(context);
    let checked: KmsContext;
    try {
      checked = checkContext(context);
    } catch (error) {
      if (error instanceof ContextRejected) {
        report(operation, "rejected", kind);
        throw failed();
      }
      report(operation, "failed", kind);
      throw failed();
    }
    if (keyId !== options.keyArn) {
      report(operation, "rejected", checked.key_kind);
      throw failed();
    }
    return checked;
  }

  async function send(
    operation: Operation,
    checked: KmsContext,
    command: GenerateDataKeyCommand | DecryptCommand,
    copy: (response: KmsSendResponse) => void,
  ): Promise<void> {
    const signal = AbortSignal.timeout(deadlineMs);
    let plaintext: Uint8Array | undefined;
    let blob: Uint8Array | undefined;
    try {
      const response = await options.client.send(command, { abortSignal: signal });
      plaintext = response.Plaintext;
      blob = response.CiphertextBlob;
      if (signal.aborted) {
        zero(plaintext);
        zero(blob);
        report(operation, "timeout", checked.key_kind);
        throw failed();
      }
      copy(response);
      zero(plaintext);
      zero(blob);
      report(operation, "ok", checked.key_kind);
    } catch (error) {
      zero(plaintext);
      zero(blob);
      if (error instanceof Error && error.message === "kms_failed") {
        throw error;
      }
      report(operation, signal.aborted ? "timeout" : "failed", checked.key_kind);
      throw failed();
    }
  }

  return {
    async generateDataKey(keyId, context) {
      const checked = await prepare("generate_data_key", keyId, context);
      let result: { plaintext: Uint8Array; blob: Uint8Array } | undefined;
      await send(
        "generate_data_key",
        checked,
        new GenerateDataKeyCommand({
          KeyId: options.keyArn,
          KeySpec: "AES_256",
          EncryptionContext: toEncryptionContext(checked),
        }),
        (response) => {
          if (!response.Plaintext || !response.CiphertextBlob) {
            throw new Error("incomplete");
          }
          result = {
            plaintext: new Uint8Array(response.Plaintext),
            blob: new Uint8Array(response.CiphertextBlob),
          };
        },
      );
      if (result === undefined) {
        throw failed();
      }
      return result;
    },
    async decrypt(keyId, blob, context) {
      const checked = await prepare("decrypt", keyId, context);
      let result: Uint8Array | undefined;
      await send(
        "decrypt",
        checked,
        new DecryptCommand({
          KeyId: options.keyArn,
          CiphertextBlob: blob,
          EncryptionContext: toEncryptionContext(checked),
        }),
        (response) => {
          if (!response.Plaintext) {
            throw new Error("incomplete");
          }
          result = new Uint8Array(response.Plaintext);
        },
      );
      if (result === undefined) {
        throw failed();
      }
      return result;
    },
  };
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
