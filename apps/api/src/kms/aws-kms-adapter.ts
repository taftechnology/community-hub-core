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
  /** Class name of the caught error. Set only when the outcome is `failed`. */
  errorClass?: string;
};

const ERROR_CLASS = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/**
 * The caught error's class name and nothing else. The message can hold a key id or an ARN, so it
 * is never read. A thrown non-Error has no class.
 */
function errorClassOf(error: unknown): string | undefined {
  if (!(error instanceof Error)) {
    return undefined;
  }
  try {
    const name: unknown = error.name;
    return typeof name === "string" && ERROR_CLASS.test(name) ? name : "Error";
  } catch {
    return "Error";
  }
}

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

  function report(
    operation: Operation,
    outcome: Outcome,
    keyKind: KeyKind | undefined,
    errorClass?: string,
  ): void {
    const fields: InfoFields = { operation, outcome };
    if (keyKind !== undefined) {
      fields.key_kind = keyKind;
    }
    if (outcome === "failed" && errorClass !== undefined) {
      fields.errorClass = errorClass;
    }
    options.info(fields);
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
      report(operation, "failed", kind, errorClassOf(error));
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
      report(
        operation,
        signal.aborted ? "timeout" : "failed",
        checked.key_kind,
        errorClassOf(error),
      );
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
