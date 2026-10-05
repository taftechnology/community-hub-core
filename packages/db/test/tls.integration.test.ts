import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDirectSql } from "../src/connections.js";
import { createPlaintextDirectSql } from "../src/plaintext.js";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ENTRYPOINT = path.join(DIR, "postgres-tls-entrypoint.sh");

let tmp = "";
let container = "";
let port = 0;
let signingCa = "";
let otherCa = "";

function run(command: string, args: string[], cwd?: string): string {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function waitForPlaintext(hostPort: number): Promise<void> {
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    const sql = createPlaintextDirectSql(`postgres://hub:local-tls-only@127.0.0.1:${hostPort}/hub`);
    try {
      await sql`select 1`;
      await sql.end({ timeout: 1 });
      return;
    } catch {
      await sql.end({ timeout: 1 }).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error("postgres did not become ready");
}

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), "hub-db-tls-"));
  writeFileSync(
    path.join(tmp, "san.cnf"),
    "subjectAltName=DNS:db.tls.test\nbasicConstraints=CA:FALSE\n",
  );
  const openssl = (args: string[]) => {
    run("openssl", args, tmp);
  };
  openssl([
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    "ca.key",
    "-out",
    "ca.crt",
    "-subj",
    "/CN=TestCA",
    "-days",
    "2",
  ]);
  openssl([
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    "server.key",
    "-out",
    "server.csr",
    "-subj",
    "/CN=db.tls.test",
  ]);
  openssl([
    "x509",
    "-req",
    "-in",
    "server.csr",
    "-CA",
    "ca.crt",
    "-CAkey",
    "ca.key",
    "-CAcreateserial",
    "-out",
    "server.crt",
    "-days",
    "2",
    "-extfile",
    "san.cnf",
  ]);
  openssl([
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    "other.key",
    "-out",
    "other.crt",
    "-subj",
    "/CN=OtherCA",
    "-days",
    "2",
  ]);
  signingCa = readFileSync(path.join(tmp, "ca.crt"), "utf8");
  otherCa = readFileSync(path.join(tmp, "other.crt"), "utf8");
  container = `ch-db-tls-${randomBytes(4).toString("hex")}`;
  run("docker", [
    "run",
    "-d",
    "--name",
    container,
    "--entrypoint",
    "/tls-entrypoint.sh",
    "-p",
    "127.0.0.1::5432",
    "-v",
    `${tmp}:/certs:ro`,
    "-v",
    `${ENTRYPOINT}:/tls-entrypoint.sh:ro`,
    "-e",
    "POSTGRES_USER=hub",
    "-e",
    "POSTGRES_PASSWORD=local-tls-only",
    "-e",
    "POSTGRES_DB=hub",
    "postgres:17",
  ]);
  const published = run("docker", ["port", container, "5432/tcp"]).trim();
  const match = published.match(/:(\d+)\s*$/);
  if (!match?.[1]) {
    throw new Error("docker port did not publish 5432");
  }
  port = Number(match[1]);
  await waitForPlaintext(port);
}, 120_000);

afterAll(() => {
  if (container) {
    try {
      run("docker", ["stop", container]);
    } catch {
      // The container may already be gone after a setup failure.
    }
    try {
      run("docker", ["rm", container]);
    } catch {
      // Removal is best-effort so a missing container does not hide the test error.
    }
  }
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
  }
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
      servername: "db.tls.test",
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
      servername: "db.tls.test",
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
      servername: "db.tls.test",
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
      servername: "db.tls.test",
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
        ca: "unused",
      }),
    ).toThrow(/servername is required when host is an IP address/);
  });
});
