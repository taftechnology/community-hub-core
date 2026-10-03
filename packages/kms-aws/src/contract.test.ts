import type { Server } from "node:http";

import type { KmsContext } from "@community-hub/crypto";
import { createServer, type BrokerKms } from "@community-hub/kms-broker-app/server";
import { afterEach, describe, expect, it } from "vitest";

import {
  createKmsBrokerClient,
  DECRYPT_PATH,
  GENERATE_DATA_KEY_PATH,
  KMS_LOGICAL_KEY_ID,
  type KmsFetch,
} from "./index.js";

const ENVELOPE_KEY_ARN = "arn:aws:kms:ap-southeast-2:123456789012:key/broker-test-envelope";

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

function createStoringKms(): BrokerKms {
  const entries = new Map<string, { plaintext: Uint8Array; context: string }>();
  return {
    async generateDataKey(input) {
      const plaintext = crypto.getRandomValues(new Uint8Array(32));
      const blob = crypto.getRandomValues(new Uint8Array(48));
      entries.set(Buffer.from(blob).toString("base64"), {
        plaintext: plaintext.slice(),
        context: JSON.stringify(input.context),
      });
      return { plaintext: plaintext.slice(), blob: blob.slice() };
    },
    async decrypt(input) {
      const entry = entries.get(Buffer.from(input.blob).toString("base64"));
      if (entry === undefined || entry.context !== JSON.stringify(input.context)) {
        throw new Error("context mismatch");
      }
      return entry.plaintext.slice();
    },
  };
}

function createThrowingKms(): BrokerKms {
  return {
    async generateDataKey() {
      throw new Error("kms unavailable");
    },
    async decrypt() {
      throw new Error("kms unavailable");
    },
  };
}

function clientUrl(input: Parameters<KmsFetch>[0]): URL {
  if (typeof input === "string") {
    return new URL(input);
  }
  if (input instanceof URL) {
    return new URL(input.href);
  }
  return new URL(input.url);
}

type RecordedCall = {
  origin: string;
  contentType: string | null;
  method: string | undefined;
  status: number;
};

function forwardFetch(port: number): {
  fetchImpl: KmsFetch;
  cacheControl: () => string | null;
  paths: () => readonly string[];
  calls: () => readonly RecordedCall[];
} {
  let cacheControl: string | null = null;
  const paths: string[] = [];
  const calls: RecordedCall[] = [];
  const fetchImpl: KmsFetch = async (input, init) => {
    const url = clientUrl(input);
    paths.push(url.pathname);
    const headers = new Headers(init?.headers);
    const contentType = headers.get("content-type");
    const upstreamInit: RequestInit = {};
    if (init?.method !== undefined) {
      upstreamInit.method = init.method;
    }
    if (contentType !== null) {
      upstreamInit.headers = { "content-type": contentType };
    }
    if (init?.body != null) {
      upstreamInit.body = init.body;
    }
    const upstream = await fetch(`http://127.0.0.1:${port}${url.pathname}`, upstreamInit);
    cacheControl = upstream.headers.get("cache-control");
    calls.push({
      origin: url.origin,
      contentType,
      method: init?.method,
      status: upstream.status,
    });
    return upstream;
  };
  return {
    fetchImpl,
    cacheControl: () => cacheControl,
    paths: () => paths,
    calls: () => calls,
  };
}

function expectClientRequest(call: RecordedCall | undefined, status?: number): void {
  expect(call?.origin).toBe("http://127.0.0.1:8080");
  expect(call?.contentType).toBe("application/json");
  expect(call?.method).toBe("POST");
  if (status !== undefined) {
    expect(call?.status).toBe(status);
  }
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

describe("broker server contract", () => {
  let server: Server | undefined;

  afterEach(async () => {
    const current = server;
    server = undefined;
    if (current === undefined) {
      return;
    }
    current.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      current.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  });

  async function start(kms: BrokerKms): Promise<number> {
    const created = createServer({
      kms,
      envelopeKeyArn: ENVELOPE_KEY_ARN,
      log: () => {},
    });
    server = created.server;
    await new Promise<void>((resolve) => {
      created.server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = created.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("broker did not bind a TCP port");
    }
    return address.port;
  }

  it("round-trips generate and decrypt for org and identity contexts with keyId envelope", async () => {
    const port = await start(createStoringKms());
    const bridge = forwardFetch(port);
    const client = createKmsBrokerClient(bridge.fetchImpl);

    expect(KMS_LOGICAL_KEY_ID).toBe("envelope");

    const orgGenerated = await client.generateDataKey("envelope", orgContext);
    expectClientRequest(bridge.calls().at(-1));
    const orgDecrypted = await client.decrypt("envelope", orgGenerated.blob, orgContext);
    expectClientRequest(bridge.calls().at(-1));
    expect(orgDecrypted).toEqual(orgGenerated.plaintext);

    const identityGenerated = await client.generateDataKey("envelope", identityContext);
    expectClientRequest(bridge.calls().at(-1));
    const identityDecrypted = await client.decrypt(
      "envelope",
      identityGenerated.blob,
      identityContext,
    );
    expectClientRequest(bridge.calls().at(-1));
    expect(identityDecrypted).toEqual(identityGenerated.plaintext);

    expect(bridge.paths()).toEqual([
      GENERATE_DATA_KEY_PATH,
      DECRYPT_PATH,
      GENERATE_DATA_KEY_PATH,
      DECRYPT_PATH,
    ]);
  });

  it("rejects generateDataKey for a key id other than envelope", async () => {
    const port = await start(createStoringKms());
    const bridge = forwardFetch(port);
    const client = createKmsBrokerClient(bridge.fetchImpl);

    await expectKmsFailed(client.generateDataKey("not-envelope", orgContext));
    expectClientRequest(bridge.calls().at(-1), 400);
    expect(bridge.cacheControl()).toBe("no-store");
  });

  it("maps a throwing KMS decrypt to kms_failed with no-store", async () => {
    const port = await start(createThrowingKms());
    const bridge = forwardFetch(port);
    const client = createKmsBrokerClient(bridge.fetchImpl);

    await expectKmsFailed(client.decrypt("envelope", new Uint8Array([1, 2, 3, 4]), orgContext));
    expectClientRequest(bridge.calls().at(-1), 502);
    expect(bridge.cacheControl()).toBe("no-store");
  });
});
