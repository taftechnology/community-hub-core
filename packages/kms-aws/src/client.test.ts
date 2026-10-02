import type { KmsContext } from "@community-hub/crypto";
import { describe, expect, it } from "vitest";

import {
  createKmsBrokerClient,
  DECRYPT_PATH,
  GENERATE_DATA_KEY_PATH,
  type KmsFetch,
} from "./index.js";

const BROKER_ORIGIN = "http://127.0.0.1:8080";

const orgContext: KmsContext = {
  key_kind: "org",
  org_id: "org-1",
  key_version: "v1",
};

const identityContext: KmsContext = {
  key_kind: "identity",
  region: "au",
  key_version: "v1",
};

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

async function expectKmsFailed(promise: Promise<unknown>): Promise<void> {
  await expect(promise).rejects.toSatisfy((error: unknown) => {
    expect(error).toBeInstanceOf(Error);
    const err = error as Error;
    expect(err.message).toBe("kms_failed");
    expect(err.cause).toBeUndefined();
    return true;
  });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("createKmsBrokerClient", () => {
  it("POSTs generate with caller keyId and org context", async () => {
    const plaintext = new Uint8Array(32).fill(7);
    const blob = new Uint8Array(48).fill(8);
    let seenUrl = "";
    let seenInit: RequestInit | undefined;
    const fetchImpl: KmsFetch = async (input, init) => {
      seenUrl = typeof input === "string" ? input : input.toString();
      seenInit = init;
      return jsonResponse(200, {
        plaintext: toBase64(plaintext),
        blob: toBase64(blob),
      });
    };

    const client = createKmsBrokerClient(fetchImpl);
    const result = await client.generateDataKey("caller-key", orgContext);

    expect(seenUrl).toBe(`${BROKER_ORIGIN}${GENERATE_DATA_KEY_PATH}`);
    expect(seenInit?.method).toBe("POST");
    const headers = new Headers(seenInit?.headers);
    expect(headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(String(seenInit?.body))).toEqual({
      keyId: "caller-key",
      context: orgContext,
    });
    expect(result.plaintext).toEqual(plaintext);
    expect(result.blob).toEqual(blob);
  });

  it("POSTs decrypt with caller keyId, context, and base64 blob", async () => {
    const argBlob = new Uint8Array([1, 2, 3, 4]);
    const plaintext = new Uint8Array(32).fill(9);
    let seenUrl = "";
    let seenInit: RequestInit | undefined;
    let seenBody: unknown;
    const recordingFetch: KmsFetch = async (input, init) => {
      seenUrl = typeof input === "string" ? input : input.toString();
      seenInit = init;
      seenBody = JSON.parse(String(init?.body));
      return jsonResponse(200, { plaintext: toBase64(plaintext) });
    };

    const client = createKmsBrokerClient(recordingFetch);
    const result = await client.decrypt("decrypt-key", argBlob, identityContext);

    expect(seenUrl).toBe(`${BROKER_ORIGIN}${DECRYPT_PATH}`);
    expect(seenInit?.method).toBe("POST");
    const headers = new Headers(seenInit?.headers);
    expect(headers.get("content-type")).toBe("application/json");
    expect(seenBody).toEqual({
      keyId: "decrypt-key",
      context: identityContext,
      blob: toBase64(argBlob),
    });
    expect(result).toEqual(plaintext);
  });

  it("throws kms_failed when a 200 body is not JSON", async () => {
    const fetchImpl: KmsFetch = async () =>
      new Response("not-json", { status: 200, headers: { "content-type": "application/json" } });
    const client = createKmsBrokerClient(fetchImpl);
    await expectKmsFailed(client.generateDataKey("k", orgContext));
    await expectKmsFailed(client.decrypt("k", new Uint8Array([1]), orgContext));
  });

  it("throws kms_failed when a 200 JSON body is not a plain object", async () => {
    for (const body of [null, 123, "x", []]) {
      const fetchImpl: KmsFetch = async () =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      await expectKmsFailed(createKmsBrokerClient(fetchImpl).generateDataKey("k", orgContext));
      await expectKmsFailed(
        createKmsBrokerClient(fetchImpl).decrypt("k", new Uint8Array([1]), orgContext),
      );
    }
  });

  it("throws kms_failed when plaintext is missing", async () => {
    const fetchGenerate: KmsFetch = async () =>
      jsonResponse(200, { blob: toBase64(new Uint8Array(1)) });
    const fetchDecrypt: KmsFetch = async () => jsonResponse(200, {});
    await expectKmsFailed(createKmsBrokerClient(fetchGenerate).generateDataKey("k", orgContext));
    await expectKmsFailed(
      createKmsBrokerClient(fetchDecrypt).decrypt("k", new Uint8Array([1]), orgContext),
    );
  });

  it("throws kms_failed when plaintext is not a string", async () => {
    const fetchImpl: KmsFetch = async () => jsonResponse(200, { plaintext: 123, blob: "YQ==" });
    await expectKmsFailed(createKmsBrokerClient(fetchImpl).generateDataKey("k", orgContext));
    await expectKmsFailed(
      createKmsBrokerClient(fetchImpl).decrypt("k", new Uint8Array([1]), orgContext),
    );
  });

  it("throws kms_failed when plaintext is invalid base64", async () => {
    const fetchImpl: KmsFetch = async () =>
      jsonResponse(200, { plaintext: "!!!not-valid-base64!!!", blob: "YQ==" });
    await expectKmsFailed(createKmsBrokerClient(fetchImpl).generateDataKey("k", orgContext));
    await expectKmsFailed(
      createKmsBrokerClient(fetchImpl).decrypt("k", new Uint8Array([1]), orgContext),
    );
  });

  it("throws kms_failed when plaintext decodes but re-encode differs (padding mismatch)", async () => {
    const fetchGenerate: KmsFetch = async () =>
      jsonResponse(200, { plaintext: "YQ", blob: "YQ==" });
    const fetchDecrypt: KmsFetch = async () => jsonResponse(200, { plaintext: "YQ" });
    await expectKmsFailed(createKmsBrokerClient(fetchGenerate).generateDataKey("k", orgContext));
    await expectKmsFailed(
      createKmsBrokerClient(fetchDecrypt).decrypt("k", new Uint8Array([1]), orgContext),
    );
  });

  it("throws kms_failed on generate when blob is missing, empty, not a string, invalid, or non-round-tripping", async () => {
    const okPlaintext = toBase64(new Uint8Array(32));
    const cases = [
      { plaintext: okPlaintext },
      { plaintext: okPlaintext, blob: 1 },
      { plaintext: okPlaintext, blob: "" },
      { plaintext: okPlaintext, blob: "!!!" },
      { plaintext: okPlaintext, blob: "YQ" },
    ];
    for (const body of cases) {
      const fetchImpl: KmsFetch = async () => jsonResponse(200, body);
      await expectKmsFailed(createKmsBrokerClient(fetchImpl).generateDataKey("k", orgContext));
    }
  });

  it("returns empty plaintext bytes when broker sends plaintext as empty string", async () => {
    const fetchGenerate: KmsFetch = async () =>
      jsonResponse(200, { plaintext: "", blob: toBase64(new Uint8Array([1])) });
    const fetchDecrypt: KmsFetch = async () => jsonResponse(200, { plaintext: "" });
    const generated = await createKmsBrokerClient(fetchGenerate).generateDataKey("k", orgContext);
    expect(generated.plaintext).toEqual(new Uint8Array(0));
    const decrypted = await createKmsBrokerClient(fetchDecrypt).decrypt(
      "k",
      new Uint8Array([1]),
      orgContext,
    );
    expect(decrypted).toEqual(new Uint8Array(0));
  });

  it("aborts a hanging fetch within deadlineMs", async () => {
    const fetchImpl: KmsFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted", "AbortError"));
        });
      });
    const client = createKmsBrokerClient(fetchImpl, 30);
    const started = Date.now();
    await expectKmsFailed(client.generateDataKey("k", orgContext));
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("throws kms_failed when fetch throws without attaching cause", async () => {
    const fetchImpl: KmsFetch = async () => {
      throw new TypeError("network down");
    };
    await expectKmsFailed(createKmsBrokerClient(fetchImpl).generateDataKey("k", orgContext));
  });

  it("throws kms_failed on 400 and 502 without echoing the response body", async () => {
    for (const status of [400, 502]) {
      const fetchImpl: KmsFetch = async () =>
        new Response(JSON.stringify({ error: "secret-detail" }), {
          status,
          headers: { "content-type": "application/json" },
        });
      await expectKmsFailed(createKmsBrokerClient(fetchImpl).generateDataKey("k", orgContext));
    }
  });

  it("returns short valid base64 plaintext without length checks", async () => {
    const short = new Uint8Array([10, 11, 12]);
    const fetchImpl: KmsFetch = async () =>
      jsonResponse(200, { plaintext: toBase64(short), blob: toBase64(new Uint8Array([1])) });
    const result = await createKmsBrokerClient(fetchImpl).generateDataKey("k", orgContext);
    expect(result.plaintext).toEqual(short);
    expect(result.plaintext.byteLength).toBeLessThan(32);
  });
});
