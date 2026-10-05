import { DecryptCommand, GenerateDataKeyCommand } from "@aws-sdk/client-kms";
import type { KmsContext } from "@community-hub/crypto";
import { describe, expect, it, vi } from "vitest";

import { createAwsKmsPort, DEFAULT_DEADLINE_MS } from "./aws-kms-adapter.js";
import { ContextRejected } from "./context.js";

const KEY_ARN = "arn:aws:kms:ap-southeast-2:123456789012:key/11111111-1111-4111-8111-111111111111";

const org: KmsContext = { key_kind: "org", org_id: "org-1", key_version: "v1" };

type Log = {
  operation: "generate_data_key" | "decrypt";
  key_kind?: "org" | "identity";
  outcome: "ok" | "rejected" | "failed" | "timeout";
};

async function rejection(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ContextRejected);
    return error as Error;
  }
  throw new Error("expected kms_failed");
}

describe("createAwsKmsPort", () => {
  it("exports a 3000 ms deadline and does not wait for it", () => {
    expect(DEFAULT_DEADLINE_MS).toBe(3000);
  });

  it("rejects a context before send and keeps key_kind when it is org", async () => {
    const send = vi.fn();
    const logs: Log[] = [];
    const port = createAwsKmsPort({
      client: { send },
      keyArn: KEY_ARN,
      info: (fields) => logs.push(fields),
    });

    const error = await rejection(() =>
      port.generateDataKey(KEY_ARN, { key_kind: "org" } as KmsContext),
    );
    expect(error.message).toBe("kms_failed");
    expect(error.cause).toBeUndefined();
    expect(send).not.toHaveBeenCalled();
    expect(logs).toEqual([{ operation: "generate_data_key", outcome: "rejected", key_kind: "org" }]);
  });

  it("rejects a key id other than the configured ARN without send", async () => {
    const send = vi.fn();
    const logs: Log[] = [];
    const port = createAwsKmsPort({
      client: { send },
      keyArn: KEY_ARN,
      info: (fields) => logs.push(fields),
    });

    const error = await rejection(() => port.generateDataKey("other-key", org));
    expect(error.message).toBe("kms_failed");
    expect(error.cause).toBeUndefined();
    expect(send).not.toHaveBeenCalled();
    expect(logs).toEqual([{ operation: "generate_data_key", outcome: "rejected", key_kind: "org" }]);
  });

  it("omits key_kind when the context kind is unknown", async () => {
    const send = vi.fn();
    const logs: Log[] = [];
    const port = createAwsKmsPort({
      client: { send },
      keyArn: KEY_ARN,
      info: (fields) => logs.push(fields),
    });

    const error = await rejection(() =>
      port.decrypt(KEY_ARN, new Uint8Array(), { key_kind: "nope" } as unknown as KmsContext),
    );
    expect(error.message).toBe("kms_failed");
    expect(send).not.toHaveBeenCalled();
    expect(logs).toEqual([{ operation: "decrypt", outcome: "rejected" }]);
    expect(logs[0]).not.toHaveProperty("key_kind");
  });

  it("times out when the response arrives after abort and zeroes the SDK buffers", async () => {
    const sdkPlaintext = new Uint8Array([1, 2, 3, 4]);
    const sdkBlob = new Uint8Array([5, 6]);
    const logs: Log[] = [];
    const port = createAwsKmsPort({
      client: {
        send: (_command, sendOptions) =>
          new Promise((resolve) => {
            sendOptions?.abortSignal?.addEventListener("abort", () => {
              resolve({ Plaintext: sdkPlaintext, CiphertextBlob: sdkBlob });
            });
          }),
      },
      keyArn: KEY_ARN,
      deadlineMs: 5,
      info: (fields) => logs.push(fields),
    });

    const error = await rejection(() => port.generateDataKey(KEY_ARN, org));
    expect(error.message).toBe("kms_failed");
    expect(error.cause).toBeUndefined();
    expect(sdkPlaintext.every((byte) => byte === 0)).toBe(true);
    expect(sdkBlob.every((byte) => byte === 0)).toBe(true);
    expect(logs).toEqual([{ operation: "generate_data_key", outcome: "timeout", key_kind: "org" }]);
  });

  it("fails an incomplete response", async () => {
    const sdkPlaintext = new Uint8Array(32).fill(5);
    const logs: Log[] = [];
    const port = createAwsKmsPort({
      client: {
        send: async () => ({ Plaintext: sdkPlaintext }),
      },
      keyArn: KEY_ARN,
      info: (fields) => logs.push(fields),
    });

    const error = await rejection(() => port.generateDataKey(KEY_ARN, org));
    expect(error.message).toBe("kms_failed");
    expect(sdkPlaintext.every((byte) => byte === 0)).toBe(true);
    expect(logs).toEqual([{ operation: "generate_data_key", outcome: "failed", key_kind: "org" }]);
  });

  it("times out when send rejects because the abort signal fired", async () => {
    const logs: Log[] = [];
    const port = createAwsKmsPort({
      client: {
        send: (_command, sendOptions) =>
          new Promise((_resolve, reject) => {
            sendOptions?.abortSignal?.addEventListener("abort", () => {
              reject(new Error("aborted"));
            });
          }),
      },
      keyArn: KEY_ARN,
      deadlineMs: 5,
      info: (fields) => logs.push(fields),
    });

    const error = await rejection(() => port.decrypt(KEY_ARN, new Uint8Array([1]), org));
    expect(error.message).toBe("kms_failed");
    expect(error.cause).toBeUndefined();
    expect(logs).toEqual([{ operation: "decrypt", outcome: "timeout", key_kind: "org" }]);
  });

  it("returns copies, zeroes the SDK buffers, and logs ok", async () => {
    const sdkPlaintext = new Uint8Array(32).fill(4);
    const sdkBlob = new Uint8Array(8).fill(6);
    const commands: Array<GenerateDataKeyCommand | DecryptCommand> = [];
    const logs: Log[] = [];
    const port = createAwsKmsPort({
      client: {
        send: async (command) => {
          commands.push(command);
          if (command instanceof DecryptCommand) {
            return { Plaintext: sdkPlaintext };
          }
          return { Plaintext: sdkPlaintext, CiphertextBlob: sdkBlob };
        },
      },
      keyArn: KEY_ARN,
      info: (fields) => logs.push(fields),
    });

    const generated = await port.generateDataKey(KEY_ARN, org);
    expect(generated.plaintext).toEqual(new Uint8Array(32).fill(4));
    expect(generated.blob).toEqual(new Uint8Array(8).fill(6));
    expect(generated.plaintext).not.toBe(sdkPlaintext);
    expect(sdkPlaintext.every((byte) => byte === 0)).toBe(true);
    expect(sdkBlob.every((byte) => byte === 0)).toBe(true);

    const decryptPlaintext = new Uint8Array(32).fill(7);
    const decryptPort = createAwsKmsPort({
      client: {
        send: async (command) => {
          commands.push(command);
        return { Plaintext: decryptPlaintext };
        },
      },
      keyArn: KEY_ARN,
      info: (fields) => logs.push(fields),
    });
    const opened = await decryptPort.decrypt(KEY_ARN, generated.blob, {
      key_kind: "identity",
      region: "ap-southeast-2",
      key_version: "v2",
    });
    expect(opened).toEqual(new Uint8Array(32).fill(7));
    expect(decryptPlaintext.every((byte) => byte === 0)).toBe(true);

    const generate = commands[0];
    expect(generate).toBeInstanceOf(GenerateDataKeyCommand);
    if (!(generate instanceof GenerateDataKeyCommand)) {
      throw new Error("expected GenerateDataKeyCommand");
    }
    expect(generate.input.KeyId).toBe(KEY_ARN);
    expect(generate.input.KeySpec).toBe("AES_256");
    expect(generate.input.EncryptionContext).toEqual({
      key_kind: "org",
      org_id: "org-1",
      key_version: "v1",
    });
    const decrypt = commands[1];
    expect(decrypt).toBeInstanceOf(DecryptCommand);
    if (!(decrypt instanceof DecryptCommand)) {
      throw new Error("expected DecryptCommand");
    }
    expect(decrypt.input.KeyId).toBe(KEY_ARN);
    expect(decrypt.input.EncryptionContext).toEqual({
      key_kind: "identity",
      region: "ap-southeast-2",
      key_version: "v2",
    });
    expect(logs).toEqual([
      { operation: "generate_data_key", outcome: "ok", key_kind: "org" },
      { operation: "decrypt", outcome: "ok", key_kind: "identity" },
    ]);
  });
});
