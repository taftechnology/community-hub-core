import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createPlaintextDirectSql } from "../../src/plaintext.js";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ENTRYPOINT = path.join(DIR, "../postgres-tls-entrypoint.sh");

/** The only name the throwaway server certificate carries. */
export const TLS_SERVER_NAME = "db.tls.test";

export type TlsCerts = {
  dir: string;
  signingCa: string;
  otherCa: string;
  cleanup(): void;
};

export type TlsPostgres = {
  name: string;
  port: number;
  stop(): void;
};

function run(command: string, args: string[], cwd?: string): string {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function waitForPlaintext(url: string): Promise<void> {
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    const sql = createPlaintextDirectSql(url);
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

/** A throwaway CA, a server certificate for TLS_SERVER_NAME signed by it, and a second CA that signed nothing. */
export function createTlsCerts(): TlsCerts {
  const dir = mkdtempSync(path.join(tmpdir(), "hub-db-tls-"));
  try {
    writeFileSync(
      path.join(dir, "san.cnf"),
      `subjectAltName=DNS:${TLS_SERVER_NAME}\nbasicConstraints=CA:FALSE\n`,
    );
    const openssl = (args: string[]) => {
      run("openssl", args, dir);
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
      `/CN=${TLS_SERVER_NAME}`,
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
    return {
      dir,
      signingCa: readFileSync(path.join(dir, "ca.crt"), "utf8"),
      otherCa: readFileSync(path.join(dir, "other.crt"), "utf8"),
      cleanup() {
        rmSync(dir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

function removeContainer(name: string): void {
  try {
    run("docker", ["stop", name]);
  } catch {
    // The container may already be gone.
  }
  try {
    run("docker", ["rm", name]);
  } catch {
    // Removal is best-effort so a missing container does not hide the test error.
  }
}

/**
 * Starts a throwaway Postgres 17 with TLS on a free loopback port. The caller
 * stops it. If it does not become ready, it is removed here before the error is
 * rethrown.
 */
export async function startTlsPostgres(opts: {
  certDir: string;
  superuser: string;
  password: string;
  database: string;
  namePrefix?: string;
}): Promise<TlsPostgres> {
  const name = `${opts.namePrefix ?? "ch-db-tls-"}${randomBytes(4).toString("hex")}`;
  try {
    run("docker", [
      "run",
      "-d",
      "--name",
      name,
      "--entrypoint",
      "/tls-entrypoint.sh",
      "-p",
      "127.0.0.1::5432",
      "-v",
      `${opts.certDir}:/certs:ro`,
      "-v",
      `${ENTRYPOINT}:/tls-entrypoint.sh:ro`,
      "-e",
      `POSTGRES_USER=${opts.superuser}`,
      "-e",
      `POSTGRES_PASSWORD=${opts.password}`,
      "-e",
      `POSTGRES_DB=${opts.database}`,
      "postgres:17",
    ]);
    const published = run("docker", ["port", name, "5432/tcp"]).trim();
    const match = published.match(/:(\d+)\s*$/);
    if (!match?.[1]) {
      throw new Error("docker port did not publish 5432");
    }
    const port = Number(match[1]);
    await waitForPlaintext(
      `postgres://${encodeURIComponent(opts.superuser)}:${encodeURIComponent(opts.password)}@127.0.0.1:${port}/${opts.database}`,
    );
    return { name, port, stop: () => removeContainer(name) };
  } catch (error) {
    try {
      run("docker", ["rm", "-f", name]);
    } catch {
      // Keep the original error.
    }
    throw error;
  }
}
