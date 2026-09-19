import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runBootstrap, setLoginPasswords } from "../src/bootstrap.js";
import { createDirectSql, createPooledSql } from "../src/connections.js";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const COMPOSE = path.join(DIR, "docker-compose.yml");
const USERLIST = path.join(DIR, ".userlist.txt");
const RUNTIME = path.join(DIR, ".runtime.json");
const DIRECT_URL = "postgres://hub:local-bootstrap-only@127.0.0.1:5432/hub";
const PRODUCT_ONLY_URL = "postgres://hub:local-bootstrap-only@127.0.0.1:5432/hub_product_only";

function compose(args: string[]): void {
  execFileSync("docker", ["compose", "-f", COMPOSE, ...args], { stdio: "inherit" });
}

async function waitForDirect(attempts = 60): Promise<void> {
  let last: unknown;
  for (let i = 0; i < attempts; i += 1) {
    const sql = createDirectSql(DIRECT_URL);
    try {
      await sql`select 1`;
      await sql.end({ timeout: 1 });
      return;
    } catch (error) {
      last = error;
      await sql.end({ timeout: 1 }).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw last instanceof Error ? last : new Error("postgres did not become ready");
}

async function waitForPgbouncer(appPassword: string, attempts = 60): Promise<void> {
  const url = `postgres://app:${encodeURIComponent(appPassword)}@127.0.0.1:6432/hub`;
  let last: unknown;
  for (let i = 0; i < attempts; i += 1) {
    const sql = createPooledSql(url);
    try {
      await sql`select 1`;
      await sql.end({ timeout: 1 });
      return;
    } catch (error) {
      last = error;
      await sql.end({ timeout: 1 }).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw last instanceof Error ? last : new Error("pgbouncer did not become ready");
}

export default async function setup(): Promise<() => void> {
  writeFileSync(USERLIST, `"placeholder" "unused"\n`, { encoding: "utf8" });
  try {
    compose(["up", "-d", "postgres"]);
    await waitForDirect();

    const passwords = {
      app: randomBytes(24).toString("base64url"),
      identity: randomBytes(24).toString("base64url"),
      platform: randomBytes(24).toString("base64url"),
    };

    const sql = createDirectSql(DIRECT_URL);
    try {
      await runBootstrap(sql);
      const { verifiers } = await setLoginPasswords(sql, passwords);
      await sql.unsafe("create database hub_product_only").simple();
      writeFileSync(
        USERLIST,
        `"app" "${verifiers.app}"\n"identity" "${verifiers.identity}"\n"platform" "${verifiers.platform}"\n`,
        { encoding: "utf8" },
      );
      writeFileSync(
        RUNTIME,
        JSON.stringify(
          { directUrl: DIRECT_URL, productOnlyUrl: PRODUCT_ONLY_URL, passwords },
          null,
          2,
        ),
        { encoding: "utf8" },
      );
    } finally {
      await sql.end({ timeout: 1 });
    }

    compose(["up", "-d", "--force-recreate", "pgbouncer"]);
    await waitForPgbouncer(passwords.app);
  } catch (error) {
    try {
      compose(["down", "-v"]);
    } catch {
      // Keep the original setup error.
    }
    throw error;
  }

  return () => {
    compose(["down", "-v"]);
  };
}
