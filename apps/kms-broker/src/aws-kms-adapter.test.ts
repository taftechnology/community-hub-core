import { DecryptCommand, GenerateDataKeyCommand } from "@aws-sdk/client-kms";
import { describe, expect, it } from "vitest";

import { createAwsBrokerKms } from "./aws-kms-adapter.js";

const KEY_ID = "arn:aws:kms:ap-southeast-2:123456789012:key/adapter-test";

describe("createAwsBrokerKms", () => {
  it("sends GenerateDataKey with KeyId, KeySpec AES_256, and EncryptionContext for org and identity", async () => {
    const commands: Array<GenerateDataKeyCommand | DecryptCommand> = [];
    const kms = createAwsBrokerKms({
      send: async (command) => {
        commands.push(command);
        return {
          Plaintext: new Uint8Array(32).fill(1),
          CiphertextBlob: new Uint8Array(16).fill(2),
        };
      },
    });

    await kms.generateDataKey(
      { keyId: KEY_ID, context: { key_kind: "org", org_id: "org-1", key_version: "v1" } },
      { abortSignal: new AbortController().signal },
    );
    await kms.generateDataKey(
      { keyId: KEY_ID, context: { key_kind: "identity", region: "au", key_version: "v2" } },
      { abortSignal: new AbortController().signal },
    );

    expect(commands).toHaveLength(2);
    const orgCmd = commands[0];
    const idCmd = commands[1];
    expect(orgCmd).toBeInstanceOf(GenerateDataKeyCommand);
    expect(idCmd).toBeInstanceOf(GenerateDataKeyCommand);
    expect(orgCmd.input.KeyId).toBe(KEY_ID);
    expect(orgCmd.input.KeySpec).toBe("AES_256");
    expect(orgCmd.input.EncryptionContext).toEqual({
      key_kind: "org",
      org_id: "org-1",
      key_version: "v1",
    });
    expect(idCmd.input.KeyId).toBe(KEY_ID);
    expect(idCmd.input.KeySpec).toBe("AES_256");
    expect(idCmd.input.EncryptionContext).toEqual({
      key_kind: "identity",
      region: "au",
      key_version: "v2",
    });
  });

  it("sends Decrypt with KeyId and EncryptionContext", async () => {
    const commands: Array<GenerateDataKeyCommand | DecryptCommand> = [];
    const kms = createAwsBrokerKms({
      send: async (command) => {
        commands.push(command);
        return { Plaintext: new Uint8Array(32).fill(3) };
      },
    });

    const blob = new Uint8Array(24).fill(4);
    await kms.decrypt(
      {
        keyId: KEY_ID,
        blob,
        context: { key_kind: "org", org_id: "org-decrypt", key_version: "v3" },
      },
      { abortSignal: new AbortController().signal },
    );

    expect(commands).toHaveLength(1);
    const cmd = commands[0];
    expect(cmd).toBeInstanceOf(DecryptCommand);
    expect(cmd.input.KeyId).toBe(KEY_ID);
    expect(cmd.input.EncryptionContext).toEqual({
      key_kind: "org",
      org_id: "org-decrypt",
      key_version: "v3",
    });
  });

  it("zeroes SDK buffers and throws when abortSignal is already aborted on fulfill", async () => {
    const sdkPlaintext = new Uint8Array(32).fill(9);
    const sdkBlob = new Uint8Array(12).fill(8);
    const kms = createAwsBrokerKms({
      send: async () => ({ Plaintext: sdkPlaintext, CiphertextBlob: sdkBlob }),
    });

    const controller = new AbortController();
    controller.abort();

    await expect(
      kms.generateDataKey(
        { keyId: KEY_ID, context: { key_kind: "org", org_id: "org-a", key_version: "v1" } },
        { abortSignal: controller.signal },
      ),
    ).rejects.toThrow("aborted");
    expect(sdkPlaintext.every((byte) => byte === 0)).toBe(true);
    expect(sdkBlob.every((byte) => byte === 0)).toBe(true);

    const decryptPlaintext = new Uint8Array(32).fill(7);
    const decryptKms = createAwsBrokerKms({
      send: async () => ({ Plaintext: decryptPlaintext }),
    });
    await expect(
      decryptKms.decrypt(
        {
          keyId: KEY_ID,
          blob: new Uint8Array(8),
          context: { key_kind: "org", org_id: "org-b", key_version: "v1" },
        },
        { abortSignal: controller.signal },
      ),
    ).rejects.toThrow("aborted");
    expect(decryptPlaintext.every((byte) => byte === 0)).toBe(true);
  });
});
