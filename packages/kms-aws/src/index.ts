import type { KmsContext, KmsPort } from "@community-hub/crypto";

export const KMS_LOGICAL_KEY_ID = "envelope";
export const GENERATE_DATA_KEY_PATH = "/v1/generate-data-key";
export const DECRYPT_PATH = "/v1/decrypt";

const BROKER_ORIGIN = "http://127.0.0.1:8080";

export type KmsFetch = typeof fetch;

function throwKmsFailed(): never {
  throw new Error("kms_failed");
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array | null {
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return null;
  }
}

function base64RoundTrips(value: string): boolean {
  if (typeof value !== "string" || value.length === 0) {
    return false;
  }
  const bytes = base64ToBytes(value);
  if (bytes === null) {
    return false;
  }
  return bytesToBase64(bytes) === value;
}

async function postBroker(
  fetchImpl: KmsFetch,
  path: string,
  body: Record<string, unknown>,
  deadlineMs: number,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetchImpl(`${BROKER_ORIGIN}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(deadlineMs),
    });
  } catch {
    throwKmsFailed();
  }
  if (!response.ok) {
    throwKmsFailed();
  }
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    throwKmsFailed();
  }
  if (parsed === null || typeof parsed !== "object") {
    throwKmsFailed();
  }
  return parsed as Record<string, unknown>;
}

function readPlaintext(record: Record<string, unknown>): Uint8Array {
  const plaintext = record.plaintext;
  if (typeof plaintext !== "string" || !base64RoundTrips(plaintext)) {
    throwKmsFailed();
  }
  return base64ToBytes(plaintext)!;
}

export function createKmsBrokerClient(fetchImpl: KmsFetch, deadlineMs = 5000): KmsPort {
  return {
    async generateDataKey(keyId: string, context: KmsContext) {
      const parsed = await postBroker(
        fetchImpl,
        GENERATE_DATA_KEY_PATH,
        { keyId, context },
        deadlineMs,
      );
      const plaintext = readPlaintext(parsed);
      const blob = parsed.blob;
      if (typeof blob !== "string" || !base64RoundTrips(blob)) {
        throwKmsFailed();
      }
      return { plaintext, blob: base64ToBytes(blob)! };
    },
    async decrypt(keyId: string, blob: Uint8Array, context: KmsContext) {
      const parsed = await postBroker(
        fetchImpl,
        DECRYPT_PATH,
        { keyId, context, blob: bytesToBase64(blob) },
        deadlineMs,
      );
      return readPlaintext(parsed);
    },
  };
}
