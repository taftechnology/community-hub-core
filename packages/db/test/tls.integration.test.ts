import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDirectSql } from "../src/connections.js";
import {
  TLS_SERVER_NAME,
  createTlsCerts,
  startTlsPostgres,
  type TlsCerts,
  type TlsPostgres,
} from "./fixtures/tls-fixture.js";

let certs: TlsCerts | undefined;
let server: TlsPostgres | undefined;
let port = 0;
let signingCa = "";
let otherCa = "";

beforeAll(async () => {
  certs = createTlsCerts();
  signingCa = certs.signingCa;
  otherCa = certs.otherCa;
  server = await startTlsPostgres({
    certDir: certs.dir,
    superuser: "hub",
    password: "local-tls-only",
    database: "hub",
  });
  port = server.port;
}, 120_000);

afterAll(() => {
  server?.stop();
  certs?.cleanup();
}, 30_000);

function hasAltNameInvalid(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current = error;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    if ("code" in current && current.code === "ERR_TLS_CERT_ALTNAME_INVALID") {
      return true;
    }
    current = current.cause;
  }
  return false;
}

function errorText(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current = error;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    for (const name of Object.getOwnPropertyNames(current)) {
      const value = (current as unknown as Record<string, unknown>)[name];
      parts.push(typeof value === "string" ? value : String(value));
    }
    current = current.cause;
  }
  return parts.join("\n");
}

describe("production TLS", () => {
  it("rejects a certificate name that is not servername", async () => {
    const sql = createDirectSql({
      host: "127.0.0.1",
      port,
      database: "hub",
      user: "hub",
      password: "local-tls-only",
      ca: signingCa,
      servername: "other.tls.test",
    });
    try {
      await expect(sql<{ n: number }[]>`select 1 as n`).rejects.toSatisfy(hasAltNameInvalid);
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it("rejects a different certificate authority", async () => {
    const sql = createDirectSql({
      host: "127.0.0.1",
      port,
      database: "hub",
      user: "hub",
      password: "local-tls-only",
      ca: otherCa,
      servername: TLS_SERVER_NAME,
    });
    try {
      await expect(sql<{ n: number }[]>`select 1 as n`).rejects.toBeInstanceOf(Error);
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it("connects with the signing CA and servername db.tls.test", async () => {
    const sql = createDirectSql({
      host: "127.0.0.1",
      port,
      database: "hub",
      user: "hub",
      password: "local-tls-only",
      ca: signingCa,
      servername: TLS_SERVER_NAME,
    });
    try {
      const rows = await sql<{ n: number }[]>`select 1 as n`;
      expect(rows[0]?.n).toBe(1);
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it("rejects a wrong password and keeps the marker out of the error", async () => {
    const marker = "pw-marker-db-tls";
    const stdout: string[] = [];
    const stderr: string[] = [];
    const writeOut = process.stdout.write.bind(process.stdout);
    const writeErr = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      stdout.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return writeOut(chunk as never, ...(rest as []));
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      stderr.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return writeErr(chunk as never, ...(rest as []));
    }) as typeof process.stderr.write;
    const sql = createDirectSql({
      host: "127.0.0.1",
      port,
      database: "hub",
      user: "hub",
      password: marker,
      ca: signingCa,
      servername: TLS_SERVER_NAME,
    });
    let caught: unknown;
    try {
      await sql<{ n: number }[]>`select 1 as n`;
    } catch (error) {
      caught = error;
    } finally {
      process.stdout.write = writeOut;
      process.stderr.write = writeErr;
      await sql.end({ timeout: 1 });
    }
    expect(caught).toBeInstanceOf(Error);
    const body = errorText(caught);
    expect(stdout.join("")).not.toContain(marker);
    expect(stderr.join("")).not.toContain(marker);
    expect(body).not.toContain(marker);
  });

  it("rejects the compose Postgres, which has no TLS", async () => {
    const sql = createDirectSql({
      host: "127.0.0.1",
      port: 5432,
      database: "hub",
      user: "hub",
      password: "local-bootstrap-only",
      ca: signingCa,
      servername: TLS_SERVER_NAME,
    });
    try {
      await expect(sql<{ n: number }[]>`select 1 as n`).rejects.toBeInstanceOf(Error);
    } finally {
      await sql.end({ timeout: 1 });
    }
  });
});

describe("IP host", () => {
  it("throws when servername is omitted", () => {
    expect(() =>
      createDirectSql({
        host: "127.0.0.1",
        port: 5432,
        database: "hub",
        user: "hub",
        password: "unused",
        ca: "-----BEGIN CERTIFICATE-----\nunused\n",
      }),
    ).toThrow(/servername is required when host is an IP address/);
  });
});

describe("factory arguments", () => {
  const base = {
    host: "db.tls.test",
    port: 5432,
    database: "hub",
    user: "hub",
    password: "unused",
    ca: "-----BEGIN CERTIFICATE-----\nunused\n",
  };

  it("throws when servername is empty", () => {
    expect(() => createDirectSql({ ...base, servername: "" })).toThrow(
      /^servername must be a non-empty string$/,
    );
  });

  it("throws when ca is empty", () => {
    expect(() => createDirectSql({ ...base, ca: "", servername: TLS_SERVER_NAME })).toThrow(
      /^ca must contain a certificate$/,
    );
  });

  it("throws when ca is not a certificate", () => {
    expect(() =>
      createDirectSql({ ...base, ca: "not a pem", servername: TLS_SERVER_NAME }),
    ).toThrow(/^ca must contain a certificate$/);
  });
});
