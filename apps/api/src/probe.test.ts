import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { KmsContext, KmsPort } from "@community-hub/crypto";
import { describe, expect, it, vi } from "vitest";

import { handleProbeCrash, runProbe, setProbeStepForTest, type ProbeDeps } from "./probe.js";

const pem = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "../certs/rds-ap-southeast-2-bundle.pem"),
  "utf8",
);

const arn = `arn:aws:kms:ap-southeast-2:123456789012:key/mrk-${"ab".repeat(16)}`;

function source(): NodeJS.ProcessEnv {
  return {
    PORT: "8080",
    PGPORT: "5432",
    AWS_REGION: "ap-southeast-2",
    NODE_ENV: "test",
    COMMUNITY_HUB_ENVIRONMENT: "staging",
    API_HOSTNAME: "au.api.example.test",
    AUTH_HOSTNAME: "auth.au.example.test",
    WEBHOOKS_HOSTNAME: "webhooks.au.example.test",
    OPS_HOSTNAME: "ops.au.example.test",
    PGHOST: "db.internal",
    PGDATABASE: "communityhub",
    PGUSER_APP: "app",
    PGUSER_IDENTITY: "identity",
    PGUSER_PLATFORM: "platform",
    PGPASSWORD_APP: "pw-app",
    PGPASSWORD_IDENTITY: "pw-identity",
    PGPASSWORD_PLATFORM: "pw-platform",
    ENVELOPE_KEY_ARN: arn,
    APP_SECRET_ARN: "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:app",
    IDENTITY_SECRET_ARN: "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:identity",
    PLATFORM_SECRET_ARN: "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:platform",
  };
}

function okSql(): ReturnType<ProbeDeps["connect"]> {
  const query = async () => [{ n: 1 }];
  return Object.assign(query, {
    end: async () => undefined,
  }) as unknown as ReturnType<ProbeDeps["connect"]>;
}

function kmsOk(plaintext: Uint8Array): KmsPort {
  return {
    async generateDataKey() {
      return { plaintext, blob: new Uint8Array([7]) };
    },
    async decrypt() {
      return new Uint8Array(plaintext);
    },
  };
}

describe("runProbe", () => {
  it("fails env before connect when PGHOST is missing", async () => {
    const env = source();
    delete env.PGHOST;
    const connect = vi.fn();
    const result = await runProbe({
      source: env,
      pem,
      connect,
      kms: kmsOk(new Uint8Array(32)),
      stepMs: 50,
    });
    expect(result).toEqual({ exitCode: 1, stdout: "fail\n", stderr: "env\n" });
    expect(connect).not.toHaveBeenCalled();
  });

  it.each([
    ["app", "db_app\n"],
    ["identity", "db_identity\n"],
    ["platform", "db_platform\n"],
  ] as const)("hides a database marker for %s", async (user, stderr) => {
    const connect = vi.fn((target: { user: string }) => {
      if (target.user === user) {
        throw new Error("marker-db-secret");
      }
      return okSql();
    });
    const result = await runProbe({
      source: source(),
      pem,
      connect: connect as unknown as ProbeDeps["connect"],
      kms: kmsOk(new Uint8Array(32)),
      stepMs: 50,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("fail\n");
    expect(result.stderr).toBe(stderr);
    expect(`${result.stdout}${result.stderr}`).not.toContain("marker-db-secret");
  });

  it("hides a KMS marker on generate", async () => {
    const kms: KmsPort = {
      async generateDataKey() {
        throw new Error("marker-kms");
      },
      async decrypt() {
        return new Uint8Array();
      },
    };
    const result = await runProbe({
      source: source(),
      pem,
      connect: (() => okSql()) as unknown as ProbeDeps["connect"],
      kms,
      stepMs: 50,
    });
    expect(result.stderr).toBe("kms_generate\n");
    expect(`${result.stdout}${result.stderr}`).not.toContain("marker-kms");
  });

  it("zeroes both copies when decrypt does not match", async () => {
    const plaintext = new Uint8Array([1, 2, 3, 4]);
    const opened = new Uint8Array([9]);
    const kms: KmsPort = {
      async generateDataKey() {
        return { plaintext, blob: new Uint8Array([1]) };
      },
      async decrypt() {
        return opened;
      },
    };
    const result = await runProbe({
      source: source(),
      pem,
      connect: (() => okSql()) as unknown as ProbeDeps["connect"],
      kms,
      stepMs: 50,
    });
    expect(result.stderr).toBe("kms_decrypt\n");
    expect(plaintext.every((byte) => byte === 0)).toBe(true);
    expect(opened.every((byte) => byte === 0)).toBe(true);
  });

  it("passes when decrypt matches and records the probe context", async () => {
    const plaintext = new Uint8Array(32).fill(4);
    const seen: Array<{ keyId: string; context: KmsContext }> = [];
    const targets: Array<{ host?: string; servername?: string; ca?: string; user?: string }> = [];
    const kms: KmsPort = {
      async generateDataKey(keyId, context) {
        seen.push({ keyId, context });
        return { plaintext, blob: new Uint8Array([8, 9]) };
      },
      async decrypt(keyId, _blob, context) {
        seen.push({ keyId, context });
        return new Uint8Array(plaintext);
      },
    };
    const result = await runProbe({
      source: source(),
      pem,
      connect: ((target: { host: string; ca: string; user: string; servername?: string }) => {
        targets.push(target);
        return okSql();
      }) as unknown as ProbeDeps["connect"],
      kms,
      stepMs: 50,
    });
    expect(result).toEqual({ exitCode: 0, stdout: "pass\n", stderr: "" });
    expect(targets.map((target) => target.user)).toEqual(["app", "identity", "platform"]);
    for (const target of targets) {
      expect(target.host).toBe("db.internal");
      expect(target.ca).toBe(pem);
      expect(target.servername).toBeUndefined();
    }
    expect(seen).toEqual([
      {
        keyId: arn,
        context: { key_kind: "identity", region: "ap-southeast-2", key_version: "probe" },
      },
      {
        keyId: arn,
        context: { key_kind: "identity", region: "ap-southeast-2", key_version: "probe" },
      },
    ]);
    expect(plaintext.every((byte) => byte === 0)).toBe(true);
  });

  it("prints only fail and the current step when the crash handler runs", () => {
    setProbeStepForTest("db_app");
    let stdout = "";
    let stderr = "";
    handleProbeCrash(
      (line) => {
        stdout += line;
      },
      (line) => {
        stderr += line;
      },
    );
    expect(stdout).toBe("fail\n");
    expect(stderr).toBe("db_app\n");
    expect(`${stdout}${stderr}`).not.toContain("marker-uncaught");
  });
});
